// Seeded-defect benchmark scorer: recall = seeded defects found / defects enabled in the run;
// precision = issues that match a seeded defect / all issues reported. Track both on every model or prompt change.
import type { Db } from "../store/db.js";
import { DEFECTS } from "../../demo-shop/defects.js";
import { normalize } from "../analysis/cluster.js";
import type { Issue } from "../types.js";
import { z } from "zod";
import { config } from "../config.js";
import { structured, textBlock } from "../llm/client.js";

// An issue counts as a seeded defect only if it names one of the defect's must-words AND either sits on the
// defect's page or hits another of its keywords. Strict on purpose: precision should not be flattered.
export function matchDefect(issue: Issue): string | null {
  const hay = normalize(`${issue.title} ${issue.description} ${issue.element}`);
  const page = normalize(issue.page);
  let best: { id: string; score: number } | null = null;
  for (const d of DEFECTS) {
    const must = d.must.some((k) => hay.includes(normalize(k)));
    if (!must) continue;
    const hits = d.keywords.filter((k) => hay.includes(normalize(k))).length;
    const pageMatch = page === normalize(d.page) || (d.page.includes(":id") && page === normalize(d.page.replace(":id", "id")));
    if (!(pageMatch || hits >= 2)) continue;
    const score = hits + (pageMatch ? 2 : 0);
    if (!best || score > best.score) best = { id: d.id, score };
  }
  return best?.id ?? null;
}

const JudgeOutput = z.object({ matches: z.array(z.object({ issue: z.number().int(), defect: z.string().nullable(), why: z.string() })) });

// A judge model maps each issue to the seeded defect it describes. Strict: same root cause and same
// place, not merely the same page or a shared word.
async function judgeMatches(issues: Issue[]): Promise<(string | null)[]> {
  const defects = DEFECTS.map((d) => `${d.id} [${d.page}] ${d.title}. What users experience: ${d.symptom}`).join("\n");
  const list = issues.map((i, n) => `${n}. [${i.page}] ${i.title} — ${i.description} (element: ${i.element})`).join("\n");
  const { value, usage } = await structured({
    model: config.models.benchmark,
    schema: JudgeOutput,
    system: "You score a usability-testing tool against a list of known, deliberately seeded defects. For each reported issue, give the id of the seeded defect it describes, or null. Match only when the issue is about the same root cause on the same part of the site. An issue that mentions a defect's page or words but describes a different problem is null. Several issues may match the same defect.",
    content: [textBlock(`Seeded defects:\n${defects}\n\nReported issues:\n${list}\n\nReturn one entry per issue index.`)],
    effort: "medium",
    name: "benchmark_matches",
  });
  const out: (string | null)[] = issues.map(() => null);
  for (const m of value.matches) if (m.issue >= 0 && m.issue < issues.length) out[m.issue] = m.defect && DEFECTS.some((d) => d.id === m.defect) ? m.defect : null;
  lastJudgeCost = usage.costUsd;
  return out;
}

let lastJudgeCost = 0;

export async function scoreBenchmark(db: Db, studyId: string, enabled: string[] = DEFECTS.map((d) => d.id), method: "auto" | "llm" | "keyword" = "auto") {
  const issues = db.issues(studyId);
  const useLlm = method === "llm" || (method === "auto" && config.modelMode === "live");
  const defects = useLlm && issues.length ? await judgeMatches(issues) : issues.map(matchDefect);
  const matches = issues.map((i, n) => ({ issue: i.title, severity: i.severity, defect: defects[n] }));
  const found = new Set(matches.map((m) => m.defect).filter((d): d is string => !!d && enabled.includes(d)));
  const truePositives = matches.filter((m) => m.defect).length;
  return {
    studyId,
    method: useLlm ? `llm-judge (${config.models.benchmark}, $${lastJudgeCost.toFixed(4)})` : "keyword",
    defectsEnabled: enabled.length,
    defectsFound: [...found].sort(),
    defectsMissed: enabled.filter((d) => !found.has(d)),
    recall: enabled.length ? Number((found.size / enabled.length).toFixed(3)) : null,
    precision: issues.length ? Number((truePositives / issues.length).toFixed(3)) : null,
    issues: matches,
  };
}
