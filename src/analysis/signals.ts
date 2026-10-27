// Pass 1: deterministic friction signals (per step, no LLM). Starting rules from the spec, tunable per site.
// Pure function over recorded steps, so it runs live during a session and again at analysis time.
import type { SignalRecord, SignalType, StepRecord } from "../types.js";
import { sha256 } from "../util/common.js";

export interface SignalRules {
  rageClickRun: number;       // consecutive activations of the same element/region
  loopRepeats: number;        // same page-state hash N times
  scrollHunt: number;         // scrolls on one page without acting
  stallSteps: number;         // steps with no new page state
  layoutShift: number;        // CLS jump between steps
  keyboardTrapTabs: number;   // Tab presses without focus leaving a small set
  slowMs: number;             // a request slower than this after an action
  loadShift: number;          // late layout shift (content arriving > 1 s after load) on arrival at a page
}

export const DEFAULT_RULES: SignalRules = {
  rageClickRun: 3,
  loopRepeats: 3,
  scrollHunt: 4,
  stallSteps: 5,
  layoutShift: 0.1,
  keyboardTrapTabs: 6,
  slowMs: 2000,
  loadShift: 0.02,
};

const ACTIVATE = new Set(["click", "tap"]);
// Clicking into a field answers with focus, not a DOM change, so it can't be a dead click.
const FIELD_ROLES = new Set(["textbox", "searchbox", "combobox", "spinbutton", "slider"]);

function sig(step: StepRecord, type: SignalType, details: Record<string, unknown>): SignalRecord {
  return { id: `sig_${sha256(`${step.id}:${type}:${JSON.stringify(details)}`).slice(0, 12)}`, stepId: step.id, sessionId: step.sessionId, type, details };
}

function sameTarget(a: StepRecord, b: StepRecord): boolean {
  if (!a.target || !b.target) return false;
  if (a.target.selector === b.target.selector && a.target.name === b.target.name) return true;
  const ca = { x: a.target.box.x + a.target.box.width / 2, y: a.target.box.y + a.target.box.height / 2 };
  const cb = { x: b.target.box.x + b.target.box.width / 2, y: b.target.box.y + b.target.box.height / 2 };
  return Math.hypot(ca.x - cb.x, ca.y - cb.y) < 30;
}

export function detectSignals(
  steps: StepRecord[],
  outcome: { status: string; detail?: string | null } | null,
  rules: SignalRules = DEFAULT_RULES,
): SignalRecord[] {
  const out: SignalRecord[] = [];
  const seenStates = new Map<string, number>();
  let rageRun = 1;
  let scrollRun = 0;
  let stallRun = 0;
  let tabRun = 0;
  let tabSteps = 0;
  const tabFocusSet = new Set<string>();

  steps.forEach((s, i) => {
    const prev = i > 0 ? steps[i - 1] : null;
    const o = s.observation;

    // Dead click: no DOM change, navigation or network call within ~1 s of the action.
    if (ACTIVATE.has(s.action.type) && !o.actionError && !o.navigated && !o.domChanged && o.networkCalls === 0 && !FIELD_ROLES.has(s.target?.role ?? "")) {
      out.push(sig(s, "dead_click", { element: s.target?.name ?? null, selector: s.target?.selector ?? null }));
    }

    // Rage click: the same element or region activated N times in a row.
    // Agent steps are not human-paced, so consecutive steps stand in for the 2 s window.
    if (prev && ACTIVATE.has(s.action.type) && ACTIVATE.has(prev.action.type) && sameTarget(s, prev)) {
      rageRun++;
      if (rageRun === rules.rageClickRun) out.push(sig(s, "rage_click", { element: s.target?.name ?? null, count: rageRun }));
    } else rageRun = 1;

    if (o.expectationMet === false) {
      out.push(sig(s, "expectation_mismatch", { expected: s.expectation.says, check: s.expectation.check.type }));
    }

    // Backtrack: explicit back, or returning to an earlier page state after leaving it.
    const earlier = seenStates.get(s.stateHash);
    if (s.action.type === "back") out.push(sig(s, "backtrack", { via: "back" }));
    else if (earlier !== undefined && prev && prev.stateHash !== s.stateHash && i - earlier > 1 && s.pagePath !== prev.pagePath) {
      out.push(sig(s, "backtrack", { via: "returned", toStep: earlier }));
    }
    const count = steps.slice(0, i + 1).filter((x) => x.stateHash === s.stateHash).length;
    if (count === rules.loopRepeats) out.push(sig(s, "loop", { stateHash: s.stateHash, repeats: count }));
    if (earlier === undefined) {
      seenStates.set(s.stateHash, i);
      stallRun = 0;
    } else {
      stallRun++;
      if (stallRun === rules.stallSteps) out.push(sig(s, "stall", { steps: stallRun }));
    }

    // Error shown: validation message, 4xx/5xx response, or console exception.
    const newValidation = o.validationMessages.filter((m) => !(prev?.observation.validationMessages ?? []).includes(m));
    const httpErrors = o.networkErrors.filter((n) => n.status >= 400 || n.status === 0);
    if (newValidation.length || httpErrors.length || o.consoleErrors.length) {
      out.push(sig(s, "error_shown", { validation: newValidation, http: httpErrors.slice(0, 5), console: o.consoleErrors.slice(0, 3) }));
    }

    if (o.searchZeroResults && (!prev || !prev.observation.searchZeroResults)) out.push(sig(s, "search_miss", { url: s.url }));

    if (s.action.type === "scroll" && (!prev || prev.pagePath === s.pagePath)) {
      scrollRun++;
      if (scrollRun === rules.scrollHunt) out.push(sig(s, "scroll_hunt", { scrolls: scrollRun, page: s.pagePath }));
    } else if (s.action.type !== "scroll") scrollRun = 0;

    // Layout: the primary action was covered by an overlay or off-screen at the persona's viewport,
    // or content shifted under the user.
    if (o.targetCovered) out.push(sig(s, "layout", { kind: "covered", element: s.target?.name ?? null }));
    else if (o.primaryActionOffscreen) out.push(sig(s, "layout", { kind: "offscreen", element: s.target?.name ?? null }));
    if (o.layoutShift >= rules.layoutShift) out.push(sig(s, "layout", { kind: "layout_shift", cls: Number(o.layoutShift.toFixed(3)) }));
    if ((o.loadShift ?? 0) >= rules.loadShift) out.push(sig(s, "layout", { kind: "load_shift", cls: o.loadShift, page: s.pagePath }));
    if (o.targetMoved) out.push(sig(s, "layout", { kind: "moved_before_tap", element: s.target?.name ?? null, dx: o.targetMoved.dx, dy: o.targetMoved.dy }));

    // Slow response: the action's request took 2 s or more. Silent when nothing on screen changed meanwhile.
    if (o.slowRequest && o.slowRequest.ms >= rules.slowMs) {
      out.push(sig(s, "slow_response", { ms: o.slowRequest.ms, request: `${o.slowRequest.method} ${o.slowRequest.url.replace(/^https?:\/\/[^/]+/, "")}`, progressShown: o.slowRequest.domChangedWhileWaiting, element: s.target?.name ?? null }));
    }

    // Accessibility: keyboard trap (Tab keeps cycling a tiny set of elements) and unnamed controls used.
    if (s.action.type === "press" && /^(shift\+)?tab$/i.test(s.action.key)) {
      tabRun += s.action.times ?? 1;
      tabSteps++;
      tabFocusSet.add(o.focusedAfter ?? "body");
      if (tabRun >= rules.keyboardTrapTabs && tabSteps >= 3 && tabFocusSet.size <= 2) {
        out.push(sig(s, "accessibility", { kind: "keyboard_trap", tabs: tabRun }));
        tabRun = 0;
        tabSteps = 0;
        tabFocusSet.clear();
      }
    } else {
      tabRun = 0;
      tabSteps = 0;
      tabFocusSet.clear();
    }
    if (s.target && !s.target.name) out.push(sig(s, "accessibility", { kind: "no_accessible_name", selector: s.target.selector, role: s.target.role }));
    if (o.actionError && /cannot activate|could not activate/i.test(o.actionError)) {
      out.push(sig(s, "accessibility", { kind: "not_keyboard_operable", error: o.actionError }));
    }
  });

  const last = steps[steps.length - 1];
  if (last && outcome) {
    if (outcome.status === "gave_up") out.push(sig(last, "give_up", { reason: outcome.detail ?? "" }));
    else if (outcome.status === "failed" || outcome.status === "timed_out") out.push(sig(last, "task_failed", { status: outcome.status, detail: outcome.detail ?? "" }));
  }
  return dedupe(out);
}

function dedupe(xs: SignalRecord[]): SignalRecord[] {
  const seen = new Set<string>();
  return xs.filter((x) => (seen.has(x.id) ? false : (seen.add(x.id), true)));
}
