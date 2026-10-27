// Pass 2: LLM critic, one call per session. Reads think-aloud, signals and key screenshots, proposes
// candidate issues, and every candidate goes through the evidence validator before it is kept.
import { z } from "zod";
import { config } from "../config.js";
import { imageBlock, isFatal, SchemaError, structured, textBlock, type LlmUsage } from "../llm/client.js";
import { CRITIC_SYSTEM } from "../llm/prompts.js";
import {
  CandidateIssueDraft, NielsenHeuristic, Impact,
  type CandidateIssue, type PersonaCard, type SignalRecord, type StepRecord, type TaskSpec,
} from "../types.js";
import type { BlobStore } from "../store/blobs.js";
import { validateCandidate } from "./validator.js";
import { embedText } from "./embed.js";
import { log, newId } from "../util/common.js";

const CriticOutput = z.object({
  issues: z.array(z.object({
    title: z.string(),
    description: z.string(),
    page: z.string(),
    element: z.string(),
    heuristic: NielsenHeuristic,
    impact: Impact,
    step_ids: z.array(z.string()),
    quotes: z.array(z.string()),
    suggested_fix: z.string(),
  })),
});

export interface CriticInput {
  sessionId: string;
  studyId: string;
  repetition: number;
  card: PersonaCard;
  task: TaskSpec;
  outcome: { status: string; detail: string | null };
  steps: StepRecord[];
  signals: SignalRecord[];
  // false once the study's budget is spent: the free rule-based critic runs instead.
  useLlm?: boolean;
}

export interface CriticResult {
  accepted: CandidateIssue[];
  rejected: { draft: CandidateIssueDraft; reasons: string[] }[];
  usage: LlmUsage | null;
}

export async function critiqueSession(input: CriticInput, blobs: BlobStore): Promise<CriticResult> {
  const elementNames = new Map<string, string[]>();
  for (const s of input.steps) {
    try {
      const els = JSON.parse(blobs.get(s.artifacts.elements).toString()) as { name: string }[];
      const texts = s.artifacts.text && blobs.exists(s.artifacts.text) ? (JSON.parse(blobs.get(s.artifacts.text).toString()) as { text: string }[]).map((b) => b.text) : [];
      // Controls and visible text both count as "seen in the step" (copy and jargon issues cite text).
      elementNames.set(s.id, [...els.map((e) => e.name).filter(Boolean), ...texts]);
    } catch {
      elementNames.set(s.id, []);
    }
  }

  let drafts: CandidateIssueDraft[];
  let usage: LlmUsage | null = null;
  if (config.modelMode === "mock" || !input.steps.length || input.useLlm === false) {
    drafts = ruleBasedCritic(input);
  } else {
    try {
      const res = await llmCritic(input, blobs);
      drafts = res.drafts;
      usage = res.usage;
    } catch (e) {
      // A failed critic call must not lose the session: fall back to the signal-based critic.
      if (isFatal(e)) throw e;
      log("critic", `${input.sessionId}: LLM critic failed (${(e as Error).message.slice(0, 120)}); using rule-based critic`);
      if (e instanceof SchemaError) usage = e.usage;
      drafts = ruleBasedCritic(input);
    }
  }

  const accepted: CandidateIssue[] = [];
  const rejected: CriticResult["rejected"] = [];
  for (const draft of drafts) {
    const v = validateCandidate(draft, input.steps, input.signals, elementNames);
    if (!v.ok) {
      rejected.push({ draft, reasons: v.reasons });
      continue;
    }
    accepted.push({
      ...draft,
      // Keep only quotes that are actually in the record.
      quotes: v.verifiedQuotes.map((q) => q.text),
      id: newId("cand"),
      sessionId: input.sessionId,
      personaId: input.card.id,
      taskId: input.task.id,
      repetition: input.repetition,
      signalTypes: v.signalTypes,
      quoteRefs: v.verifiedQuotes,
      embedding: embedText(`${draft.title} ${draft.description} ${draft.page} ${draft.element}`),
    });
  }
  return { accepted, rejected, usage };
}

async function llmCritic(input: CriticInput, blobs: BlobStore): Promise<{ drafts: CandidateIssueDraft[]; usage: LlmUsage }> {
  const sigByStep = new Map<string, SignalRecord[]>();
  for (const s of input.signals) sigByStep.set(s.stepId, [...(sigByStep.get(s.stepId) ?? []), s]);

  const lines = input.steps.map((s) => {
    const o = s.observation;
    const sig = (sigByStep.get(s.id) ?? []).map((x) => `${x.type}${Object.keys(x.details).length ? ` ${JSON.stringify(x.details)}` : ""}`);
    return [
      `step_id=${s.id} #${s.idx} page=${s.pagePath} title="${s.title}"`,
      `  think-aloud: "${s.thinkAloud}" (confidence ${s.confidence}/5, frustration ${s.frustration}/10)`,
      `  action: ${JSON.stringify(s.action)}${s.target ? ` on ${s.target.role} "${s.target.name || "(no accessible name)"}" [${s.target.selector}]` : ""}`,
      `  expected: "${s.expectation.says}" -> ${o.expectationMet === null ? "not testable" : o.expectationMet ? "met" : "NOT met"}`,
      `  observed: navigated=${o.navigated}${o.targetMoved ? ` targetMovedBeforeTap=${o.targetMoved.dy}px` : ""} domChanged=${o.domChanged} network=${o.networkCalls}${o.slowRequest ? ` slowRequest=${o.slowRequest.ms}ms progressShown=${o.slowRequest.domChangedWhileWaiting}` : ""}${o.loadShift ? ` loadShift=${o.loadShift}` : ""}${o.validationMessages.length ? ` messages=${JSON.stringify(o.validationMessages)}` : ""}${o.actionError ? ` error="${o.actionError}"` : ""}${o.targetCovered ? " tap-hit-overlay" : ""}`,
      sig.length ? `  signals: ${sig.join("; ")}` : "",
    ].filter(Boolean).join("\n");
  });

  // Key screenshots: steps where signals fired, plus the last step. At most 5 images.
  const keySteps = [...new Set([...input.signals.map((s) => s.stepId), input.steps.at(-1)!.id])]
    .map((id) => input.steps.find((s) => s.id === id))
    .filter((s): s is StepRecord => !!s && !!(s.artifacts.before_marked ?? s.artifacts.before))
    .slice(-5);
  const images = keySteps.flatMap((s) => [textBlock(`Screenshot for step_id=${s.id} (#${s.idx}, ${s.pagePath}):`), imageBlock(blobs.get(s.artifacts.before_marked ?? s.artifacts.before))]);

  const c = input.card;
  const header = `Persona: ${c.name}, ${c.archetype}. Device ${c.device.viewport}${c.device.touch ? " touch" : ""}, literacy ${c.digital_literacy}/5, reading ${c.reading}` +
    `${c.accessibility.screen_reader ? ", screen reader" : ""}${c.accessibility.keyboard_only ? ", keyboard only" : ""}${c.accessibility.zoom > 100 ? `, zoom ${c.accessibility.zoom}%` : ""}.` +
    `\nTask: ${input.task.goal}\nOutcome: ${input.outcome.status}${input.outcome.detail ? ` (${input.outcome.detail})` : ""}`;

  const { value, usage } = await structured({
    model: config.models.critic,
    schema: CriticOutput,
    system: CRITIC_SYSTEM,
    content: [textBlock(`${header}\n\nSteps:\n${lines.join("\n")}`), ...images, textBlock("Propose the candidate issues for this session.")],
    effort: config.effort.critic,
    maxTokens: 12000,
    name: "candidate_issues",
  });
  return { drafts: value.issues.map((i) => CandidateIssueDraft.parse(i)), usage };
}

// Offline critic: turns deterministic signals into candidates with the agent's own words as quotes.
export function ruleBasedCritic(input: CriticInput): CandidateIssueDraft[] {
  const failed = input.outcome.status !== "succeeded";
  const lastIdx = input.steps.at(-1)?.idx ?? 0;
  const byKey = new Map<string, CandidateIssueDraft>();
  for (const sig of input.signals) {
    const step = input.steps.find((s) => s.id === sig.stepId);
    if (!step) continue;
    const el = step.target?.name || (step.target ? `unlabeled ${step.target.role}` : "page");
    const d = sig.details as Record<string, unknown>;
    let draft: Omit<CandidateIssueDraft, "step_ids" | "quotes" | "page" | "impact"> | null = null;
    switch (sig.type) {
      case "dead_click":
        draft = { title: `"${el}" does nothing when pressed`, description: `Pressing "${el}" produced no visible change, navigation or request.`, element: el, heuristic: "visibility_of_system_status" };
        break;
      case "layout":
        draft = d.kind === "covered"
          ? { title: `"${el}" is covered by another element`, description: `The tap on "${el}" landed on an overlay instead.`, element: el, heuristic: "aesthetic_and_minimalist_design" }
          : d.kind === "moved_before_tap"
            ? { title: `Content moved just before tapping "${el}"`, description: `The page shifted ${Math.abs(Number(d.dy))}px between seeing "${el}" and tapping it, so the tap landed elsewhere.`, element: el, heuristic: "consistency_and_standards" }
          : d.kind === "load_shift"
            ? { title: `Content jumps after ${step.pagePath} loads`, description: `Content that loaded more than a second late shifted the page (layout shift ${d.cls}), so anything a person was about to tap moved.`, element: "page", heuristic: "consistency_and_standards" }
          : d.kind === "offscreen"
            ? { title: `"${el}" is off-screen at this viewport`, description: `The primary action "${el}" was not visible without scrolling.`, element: el, heuristic: "recognition_rather_than_recall" }
            : { title: `Content shifts under the user on ${step.pagePath}`, description: `Layout shift of ${d.cls} after the action.`, element: el, heuristic: "consistency_and_standards" };
        break;
      case "search_miss":
        draft = { title: "Site search returns no results", description: "A plausible search query returned zero results.", element: el, heuristic: "match_between_system_and_real_world" };
        break;
      case "error_shown":
        if ((d.validation as string[] | undefined)?.length) {
          draft = { title: `Form error on ${step.pagePath}: ${(d.validation as string[])[0].slice(0, 60)}`, description: `Validation message shown: ${(d.validation as string[]).join("; ")}`, element: el, heuristic: "help_users_recognize_diagnose_recover_from_errors" };
        }
        break;
      case "accessibility":
        if (d.kind === "no_accessible_name") draft = { title: `Control with no accessible name on ${step.pagePath}`, description: `A ${step.target?.role ?? "control"} (${d.selector}) has no accessible name.`, element: el, heuristic: "consistency_and_standards" };
        if (d.kind === "keyboard_trap") draft = { title: `Keyboard focus is trapped on ${step.pagePath}`, description: "Tab cycles inside a small set of elements and cannot leave it.", element: "focus trap", heuristic: "user_control_and_freedom" };
        if (d.kind === "not_keyboard_operable") draft = { title: `"${el}" cannot be operated from the keyboard`, description: String(d.error), element: el, heuristic: "flexibility_and_efficiency_of_use" };
        break;
      case "slow_response":
        draft = { title: `"${el}" is slow to respond${d.progressShown ? "" : " with no progress indicator"}`, description: `${d.request} took ${(Number(d.ms) / 1000).toFixed(1)} s after pressing "${el}"${d.progressShown ? "" : ", and nothing on screen showed it was working"}.`, element: el, heuristic: "visibility_of_system_status" };
        break;
      case "rage_click":
        draft = { title: `Repeated presses on "${el}"`, description: `The user pressed "${el}" ${d.count} times in a row.`, element: el, heuristic: "visibility_of_system_status" };
        break;
      case "give_up":
      case "task_failed":
        draft = { title: `Task abandoned on ${step.pagePath}`, description: `Session ended ${input.outcome.status}: ${input.outcome.detail ?? ""}`, element: el, heuristic: "user_control_and_freedom" };
        break;
      default:
        break;
    }
    if (!draft) continue;
    const key = `${step.pagePath}|${draft.title}`;
    const prev = byKey.get(key);
    const terminal = sig.type === "give_up" || sig.type === "task_failed";
    const atTheEnd = failed && step.idx === lastIdx && ["dead_click", "layout", "error_shown", "accessibility"].includes(sig.type);
    const impact: CandidateIssueDraft["impact"] = terminal || atTheEnd ? "blocked" : sig.type === "layout" || sig.type === "dead_click" ? "major_detour" : "minor_friction";
    if (prev) {
      if (!prev.step_ids.includes(step.id)) prev.step_ids.push(step.id);
      continue;
    }
    byKey.set(key, { ...draft, page: step.pagePath, impact, step_ids: [step.id], quotes: step.thinkAloud ? [step.thinkAloud] : [] });
  }
  return [...byKey.values()];
}
