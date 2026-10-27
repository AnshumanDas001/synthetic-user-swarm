// The "no evidence, no issue" gate. A candidate from the critic survives only if:
//  - every cited step id exists in this session,
//  - the named element appears in those steps (as the action target, in the element list, or in the think-aloud),
//  - and it has a deterministic signal or a verbatim agent quote behind it.
import type { CandidateIssueDraft, SignalRecord, StepRecord } from "../types.js";
import { normalize } from "./cluster.js";

export interface ValidationResult {
  ok: boolean;
  reasons: string[];
  // Quotes that were found verbatim (or near-verbatim) in the cited steps' think-aloud.
  verifiedQuotes: { text: string; stepId: string }[];
  signalTypes: SignalRecord["type"][];
}

export function validateCandidate(
  c: CandidateIssueDraft,
  steps: StepRecord[],
  signals: SignalRecord[],
  elementNamesByStep: Map<string, string[]>,
): ValidationResult {
  const reasons: string[] = [];
  const byId = new Map(steps.map((s) => [s.id, s]));
  const cited = c.step_ids.map((id) => byId.get(id)).filter((s): s is StepRecord => !!s);
  const missing = c.step_ids.filter((id) => !byId.has(id));
  if (missing.length) reasons.push(`cites step ids that do not exist: ${missing.join(", ")}`);
  if (!cited.length) reasons.push("cites no existing steps");

  const el = normalize(c.element);
  const elementSeen = cited.some((s) => {
    // Symbol-only names ("×", "☰") normalise to nothing: compare them verbatim.
    if (!el) return !!c.element.trim() && (s.target?.name.trim() === c.element.trim() || (elementNamesByStep.get(s.id) ?? []).includes(c.element.trim()));
    // Page-level issues name the page itself.
    if (el === normalize(s.pagePath) || el === normalize(s.title) || el === "page") return true;
    const target = normalize(s.target?.name ?? "");
    if (target && (target.includes(el) || el.includes(target))) return true;
    if (s.target?.selector && normalize(s.target.selector).includes(el)) return true;
    const names = (elementNamesByStep.get(s.id) ?? []).map(normalize);
    if (names.some((n) => n && (n.includes(el) || el.includes(n)))) return true;
    // An element can be named by what it looks like ("unlabeled search icon") when it has no name;
    // accept if the key words appear in the think-aloud or among the step's element names.
    const words = el.split(" ").filter((w) => w.length > 3);
    const hay = `${normalize(s.thinkAloud)} ${names.join(" ")} ${target}`;
    return words.length > 0 && words.filter((w) => hay.includes(w)).length >= Math.ceil(words.length / 2);
  });
  if (!elementSeen) reasons.push(`element "${c.element}" does not appear in the cited steps`);

  const citedIds = new Set(cited.map((s) => s.id));
  const sigs = signals.filter((s) => citedIds.has(s.stepId));
  const verifiedQuotes: ValidationResult["verifiedQuotes"] = [];
  for (const q of c.quotes) {
    const nq = normalize(q);
    if (nq.length < 4) continue;
    const src = cited.find((s) => normalize(s.thinkAloud).includes(nq) || (nq.length > 20 && overlap(normalize(s.thinkAloud), nq) > 0.8));
    if (src) verifiedQuotes.push({ text: q, stepId: src.id });
  }
  if (!sigs.length && !verifiedQuotes.length) reasons.push("no signal or verbatim quote behind it");

  return { ok: reasons.length === 0, reasons, verifiedQuotes, signalTypes: [...new Set(sigs.map((s) => s.type))] };
}

function overlap(hay: string, needle: string): number {
  const h = new Set(hay.split(" "));
  const n = needle.split(" ");
  return n.filter((w) => h.has(w)).length / n.length;
}
