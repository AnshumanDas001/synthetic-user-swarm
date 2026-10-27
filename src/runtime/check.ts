// Check stage: pure code, no LLM, which is why its signals can be trusted.
// Tests the agent's expectation predicate, the task's success criteria, and estimates human time.
import type { Page } from "playwright";
import type { AgentAction, ExpectationCheck, PersonaCard, SuccessCriteria } from "../types.js";
import type { NetEntry } from "./sandbox.js";
import { readingWpm } from "../personas/profiles.js";

export interface Snapshot {
  url: string;
  bodyText: string;
  dialogOpen: boolean;
  focused: string | null;
  marked: Record<number, { text: string; html: string; value: unknown } | null>;
}

export async function snapshot(page: Page, marks: number[], dialogOpen: boolean, focused: string | null): Promise<Snapshot> {
  // Visible text plus what is typed into fields (innerText leaves out input values).
  const bodyText = (await page.evaluate(`document.body ? document.body.innerText + "\\n" + Array.from(document.querySelectorAll("input:not([type=password]),textarea")).map((e) => e.value).filter(Boolean).join("\\n") : ""`).catch(() => "")) as string;
  const marked: Snapshot["marked"] = {};
  for (const m of marks) marked[m] = (await page.evaluate(`window.__sus && window.__sus.elementState(${m})`).catch(() => null)) as Snapshot["marked"][number];
  return { url: page.url(), bodyText, dialogOpen, focused, marked };
}

export function marksFor(check: ExpectationCheck): number[] {
  return check.type === "text_changes" || check.type === "element_changes" ? [check.mark] : [];
}

// Returns null when the agent made no testable prediction.
export function expectationMet(check: ExpectationCheck, before: Snapshot, after: Snapshot): boolean | null {
  switch (check.type) {
    case "none":
      return null;
    case "url_changes":
      return stripHash(before.url) !== stripHash(after.url);
    case "url_contains":
      return after.url.toLowerCase().includes(check.value.toLowerCase());
    case "text_appears": {
      const needle = check.value.toLowerCase().trim();
      return after.bodyText.toLowerCase().includes(needle) && (!before.bodyText.toLowerCase().includes(needle) || before.url !== after.url);
    }
    case "text_changes": {
      const b = before.marked[check.mark];
      const a = after.marked[check.mark];
      return !!b && (!a || a.text !== b.text);
    }
    case "element_changes": {
      const b = before.marked[check.mark];
      const a = after.marked[check.mark];
      return !!b && (!a || a.html !== b.html || a.value !== b.value);
    }
    case "dialog_opens":
      return !before.dialogOpen && after.dialogOpen;
    case "focus_moves":
      return before.focused !== after.focused;
  }
}

function stripHash(u: string): string {
  return u.split("#")[0];
}

// ---------------------------------------------------------------- success checker

export interface SuccessResult {
  success: boolean;
  checks: { kind: string; passed: boolean; detail: string }[];
}

// Success is never taken on the agent's word: it is tested against the task's criteria.
export function checkSuccess(
  criteria: SuccessCriteria,
  state: { url: string; bodyText: string; network: NetEntry[] },
  judge?: { passed: boolean; detail: string } | null,
): SuccessResult {
  const checks: SuccessResult["checks"] = [];
  if (criteria.url_pattern) {
    const passed = new RegExp(criteria.url_pattern, "i").test(state.url);
    checks.push({ kind: "url_pattern", passed, detail: `${state.url} ~ /${criteria.url_pattern}/` });
  }
  if (criteria.text_present) {
    const passed = state.bodyText.toLowerCase().includes(criteria.text_present.toLowerCase());
    checks.push({ kind: "text_present", passed, detail: `"${criteria.text_present}"` });
  }
  if (criteria.network) {
    const re = new RegExp(criteria.network.url_pattern, "i");
    const hit = state.network.find(
      (n) => n.method.toUpperCase() === criteria.network!.method.toUpperCase() && re.test(n.url) && (criteria.network!.status === undefined || n.status === criteria.network!.status),
    );
    checks.push({ kind: "network", passed: !!hit, detail: `${criteria.network.method} ${criteria.network.url_pattern} ${criteria.network.status ?? ""}`.trim() });
  }
  if (criteria.llm_judge && judge) checks.push({ kind: "llm_judge", passed: judge.passed, detail: judge.detail });
  if (!checks.length) return { success: false, checks };
  const success = criteria.mode === "all" ? checks.every((c) => c.passed) : checks.some((c) => c.passed);
  return { success, checks };
}

// ---------------------------------------------------------------- time on task (KLM-style estimate)

// Operator times in ms (Card, Moran & Newell): K keystroke, P point, B button, H home, M mental prep.
const KLM = { K: 280, P: 1100, B: 100, H: 400, M: 1350, tap: 700 };

export function estimateHumanMs(card: PersonaCard, action: AgentAction, wordsSeen: number, charsTyped: number): number {
  const readMs = (wordsSeen / readingWpm(card)) * 60_000;
  // Lower literacy means slower typing and more hesitation before acting.
  const literacy = 1 + (3 - card.digital_literacy) * 0.15;
  let actMs = 0;
  switch (action.type) {
    case "click":
      actMs = KLM.P + KLM.B;
      break;
    case "tap":
      actMs = KLM.tap;
      break;
    case "type":
      actMs = KLM.P + KLM.B + KLM.H + charsTyped * KLM.K * (card.device.touch ? 1.6 : 1);
      break;
    case "select":
      actMs = 2 * (KLM.P + KLM.B);
      break;
    case "scroll":
      actMs = 800;
      break;
    case "press":
      actMs = KLM.K * (action.times ?? 1);
      break;
    case "hover":
      actMs = KLM.P;
      break;
    case "back":
      actMs = KLM.P + KLM.B;
      break;
    case "wait":
      actMs = action.seconds * 1000;
      break;
    default:
      actMs = 0;
  }
  return Math.round(readMs + (KLM.M + actMs) * literacy);
}
