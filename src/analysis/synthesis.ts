// Pass 3: cross-session synthesis. Cluster candidates, let an LLM merge clusters that share a root
// cause, then compute reach, severity and confidence and pick the strongest evidence for each card.
import { z } from "zod";
import { config } from "../config.js";
import { structured, textBlock, type LlmUsage } from "../llm/client.js";
import { MERGE_SYSTEM } from "../llm/prompts.js";
import type { SessionRow } from "../store/db.js";
import { IMPACT_SCORE, type CandidateIssue, type Impact, type Issue, type PersonaCard, type SignalRecord, type SignalType, type StepRecord } from "../types.js";
import { agglomerative, normalize } from "./cluster.js";
import { confidence, reachLabel, severity } from "./severity.js";
import { isMobile } from "../personas/profiles.js";
import { sha256 } from "../util/common.js";

const MergeOutput = z.object({
  issues: z.array(z.object({
    cluster_ids: z.array(z.string()),
    title: z.string(),
    description: z.string(),
    suggested_fix: z.string(),
  })),
});

export interface SynthesisInput {
  studyId: string;
  candidates: CandidateIssue[];
  sessions: SessionRow[];
  stepsBySession: Map<string, StepRecord[]>;
  signalsBySession: Map<string, SignalRecord[]>;
  personas: PersonaCard[];
  useLlmMerge: boolean;
}

// Signal priority when picking which steps make the issue card.
const SIGNAL_RANK: SignalType[] = ["layout", "slow_response", "dead_click", "rage_click", "expectation_mismatch", "error_shown", "accessibility", "search_miss", "give_up", "task_failed", "loop", "stall", "backtrack", "scroll_hunt"];

export async function synthesize(input: SynthesisInput): Promise<{ issues: Issue[]; usage: LlmUsage | null }> {
  const { candidates } = input;
  if (!candidates.length) return { issues: [], usage: null };

  const clusters = agglomerative(candidates);
  let groups: { members: CandidateIssue[]; title?: string; description?: string; fix?: string }[] = clusters.map((c) => ({ members: c }));
  let usage: LlmUsage | null = null;

  if (input.useLlmMerge && config.modelMode === "live" && clusters.length > 1) {
    const labelled = clusters.map((c, i) => ({ id: `c${i + 1}`, members: c }));
    const listing = labelled.map((c) => {
      const titles = [...new Set(c.members.map((m) => m.title))].slice(0, 6);
      return `${c.id}: page=${mode(c.members.map((m) => m.page))} element="${mode(c.members.map((m) => m.element))}" n=${c.members.length}\n  titles: ${titles.map((t) => `"${t}"`).join("; ")}`;
    }).join("\n");
    try {
      const res = await structured({
        model: config.models.synthesis,
        schema: MergeOutput,
        system: MERGE_SYSTEM,
        content: [textBlock(`Clusters:\n${listing}\n\nReturn every cluster id exactly once across the issues.`)],
        effort: "medium",
        maxTokens: 12000,
        name: "merged_issues",
      });
      usage = res.usage;
      const used = new Set<string>();
      const merged: typeof groups = [];
      for (const iss of res.value.issues) {
        const members = iss.cluster_ids.filter((id) => !used.has(id)).flatMap((id) => {
          used.add(id);
          return labelled.find((c) => c.id === id)?.members ?? [];
        });
        if (members.length) merged.push({ members, title: iss.title, description: iss.description, fix: iss.suggested_fix });
      }
      // Any cluster the model forgot stays as its own issue.
      for (const c of labelled) if (!used.has(c.id)) merged.push({ members: c.members });
      groups = merged;
    } catch {
      // Merge pass is an improvement, not a dependency: fall back to the raw clusters.
    }
  }

  const sessionById = new Map(input.sessions.map((s) => [s.id, s]));
  const personaById = new Map(input.personas.map((p) => [p.id, p]));
  const analysable = input.sessions.filter((s) => !["queued", "provisioning", "running", "infra_error"].includes(s.status));

  const issues = groups.map((g) => buildIssue(g, input, sessionById, personaById, analysable));
  issues.sort((a, b) => b.severity - a.severity || b.reach.sessions - a.reach.sessions);
  return { issues, usage };
}

function buildIssue(
  g: { members: CandidateIssue[]; title?: string; description?: string; fix?: string },
  input: SynthesisInput,
  sessionById: Map<string, SessionRow>,
  personaById: Map<string, PersonaCard>,
  analysable: SessionRow[],
): Issue {
  const m = g.members;
  const page = mode(m.map((c) => c.page));
  const element = mode(m.map((c) => c.element));
  const sessions = [...new Set(m.map((c) => c.sessionId))];
  const personaIds = [...new Set(m.map((c) => c.personaId))];
  const repetitions = new Set(m.map((c) => c.repetition));
  const taskIds = [...new Set(m.map((c) => c.taskId))];

  // Sessions that reached the page (any task in this issue). Late-funnel issues are not underrated.
  const reached = analysable.filter((s) => taskIds.includes(s.taskId) && (input.stepsBySession.get(s.id) ?? []).some((st) => st.pagePath === page || normalize(st.pagePath) === normalize(page)));
  const sessionsReachedPage = Math.max(reached.length, sessions.length);

  // Impact: the most common claim, but "blocked" only counts when those sessions really failed.
  const impact = resolveImpact(m, sessionById);

  const signalTypes = [...new Set(m.flatMap((c) => c.signalTypes))];
  const personaPassedElsewhere = personaIds.length === 1 && analysable.some((s) => s.personaId === personaIds[0] && taskIds.includes(s.taskId) && s.outcome === "succeeded" && !sessions.includes(s.id));
  const conf = confidence({ signalTypes, personas: personaIds.length, sessions: sessions.length, repetitionsHit: repetitions.size, personaPassedElsewhere });

  // Segment label for the reach line: "5 of 6 mobile sessions" when every hit is mobile.
  const cards = personaIds.map((id) => personaById.get(id)).filter((c): c is PersonaCard => !!c);
  const allMobile = cards.length > 0 && cards.every(isMobile);
  const segReached = allMobile ? reached.filter((s) => { const c = personaById.get(s.personaId); return c && isMobile(c); }).length : sessionsReachedPage;

  const evidenceStepIds = pickEvidence(m, input.signalsBySession);
  const quotes = dedupeBy(m.flatMap((c) => c.quoteRefs ?? []), (q) => normalize(q.text)).slice(0, 2);
  const base = m.reduce((best, c) => (IMPACT_SCORE[c.impact] > IMPACT_SCORE[best.impact] ? c : best), m[0]);

  return {
    id: `iss_${sha256(m.map((c) => c.id).sort().join(",")).slice(0, 10)}`,
    studyId: input.studyId,
    taskIds,
    title: g.title ?? base.title,
    description: g.description ?? base.description,
    page,
    element,
    heuristic: mode(m.map((c) => c.heuristic)),
    impact,
    severity: severity(impact, sessions.length, sessionsReachedPage),
    confidence: conf.level,
    needsReview: conf.needsReview,
    reach: {
      sessions: sessions.length,
      sessionsReachedPage,
      personas: personaIds.length,
      repetitions: repetitions.size,
      label: reachLabel(sessions.length, allMobile ? Math.max(segReached, sessions.length) : sessionsReachedPage, personaIds.length, allMobile ? "mobile" : undefined),
    },
    personaIds,
    candidateIds: m.map((c) => c.id),
    evidenceStepIds,
    quotes,
    signalTypes,
    suggestedFix: g.fix ?? m.find((c) => c.suggested_fix)?.suggested_fix,
    status: "open",
    fingerprint: fingerprint(page, element, mode(m.map((c) => c.heuristic))),
  };
}

function resolveImpact(m: CandidateIssue[], sessionById: Map<string, SessionRow>): Impact {
  const valid = m.map((c) => {
    if (c.impact !== "blocked") return c.impact;
    const s = sessionById.get(c.sessionId);
    return s && s.outcome !== "succeeded" ? "blocked" : "major_detour";
  });
  // Take the highest impact that at least a third of the members agree on.
  const order: Impact[] = ["blocked", "major_detour", "minor_friction", "cosmetic"];
  for (const level of order) {
    const atLeast = valid.filter((v) => IMPACT_SCORE[v] >= IMPACT_SCORE[level]).length;
    if (atLeast / valid.length >= 1 / 3) return level;
  }
  return "cosmetic";
}

// The 3–5 strongest evidence steps: the clearest screenshot, the most telling quote, the signal that fired.
function pickEvidence(m: CandidateIssue[], signalsBySession: Map<string, SignalRecord[]>): string[] {
  const scored = m.flatMap((c) => {
    const sigs = signalsBySession.get(c.sessionId) ?? [];
    return c.step_ids.map((id) => {
      const types = sigs.filter((s) => s.stepId === id).map((s) => s.type);
      const best = Math.min(...types.map((t) => SIGNAL_RANK.indexOf(t)).filter((i) => i >= 0), 99);
      const quoted = (c.quoteRefs ?? []).some((q) => q.stepId === id);
      return { id, sessionId: c.sessionId, score: (99 - best) + (quoted ? 20 : 0) };
    });
  });
  scored.sort((a, b) => b.score - a.score);
  // Prefer diversity across sessions.
  const out: string[] = [];
  const usedSessions = new Set<string>();
  for (const s of scored) if (!usedSessions.has(s.sessionId) && out.length < 5) { out.push(s.id); usedSessions.add(s.sessionId); }
  for (const s of scored) if (!out.includes(s.id) && out.length < 3) out.push(s.id);
  return out;
}

export function fingerprint(page: string, element: string, heuristic: string): string {
  return sha256(`${normalize(page)}|${normalize(element)}|${heuristic}`).slice(0, 12);
}

function mode<T>(xs: T[]): T {
  const counts = new Map<T, number>();
  for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

function dedupeBy<T>(xs: T[], key: (x: T) => string): T[] {
  const seen = new Set<string>();
  return xs.filter((x) => (seen.has(key(x)) ? false : (seen.add(key(x)), true)));
}
