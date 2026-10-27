// Severity and confidence rules, exactly as the spec defines them.
import type { Confidence, Impact, SignalType } from "../types.js";
import { IMPACT_SCORE } from "../types.js";

// severity = impact × (0.5 + 0.5 · sessions affected / sessions that reached the page)
// Dividing by sessions that reached the page stops late-funnel issues from being underrated.
// Result lies on Nielsen's 0–4 scale.
export function severity(impact: Impact, sessionsAffected: number, sessionsReachedPage: number): number {
  const reached = Math.max(sessionsReachedPage, sessionsAffected, 1);
  const s = IMPACT_SCORE[impact] * (0.5 + 0.5 * (sessionsAffected / reached));
  return Math.round(s * 100) / 100;
}

export function severityLabel(s: number): string {
  if (s >= 3.5) return "catastrophic";
  if (s >= 2.5) return "major";
  if (s >= 1.5) return "minor";
  if (s >= 0.5) return "cosmetic";
  return "not a problem";
}

const DETERMINISTIC: SignalType[] = [
  "dead_click", "rage_click", "expectation_mismatch", "backtrack", "loop", "error_shown", "search_miss",
  "scroll_hunt", "stall", "give_up", "task_failed", "accessibility", "layout", "slow_response",
];

// High:   a deterministic signal plus 2+ personas, repeated across runs.
// Medium: LLM-identified, but repeated across sessions or personas.
// Low:    one session only, or the same persona passed on other repetitions -> needs human review.
export function confidence(args: {
  signalTypes: SignalType[];
  personas: number;
  sessions: number;
  repetitionsHit: number;     // distinct repetition indices on which the issue appeared
  personaPassedElsewhere: boolean;
}): { level: Confidence; needsReview: boolean } {
  const hasSignal = args.signalTypes.some((t) => DETERMINISTIC.includes(t));
  if (hasSignal && args.personas >= 2 && args.repetitionsHit >= 2) return { level: "high", needsReview: false };
  if (args.sessions <= 1 || (args.personas <= 1 && args.personaPassedElsewhere)) return { level: "low", needsReview: true };
  return { level: "medium", needsReview: false };
}

// Reach label for an issue card: "5 of 6 mobile sessions, 3 personas".
export function reachLabel(sessions: number, reached: number, personas: number, segment?: string): string {
  return `${sessions} of ${reached}${segment ? ` ${segment}` : ""} sessions, ${personas} persona${personas === 1 ? "" : "s"}`;
}
