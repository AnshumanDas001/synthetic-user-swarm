import { describe, expect, it } from "vitest";
import { confidence, severity, severityLabel } from "../src/analysis/severity.js";
import { detectSignals } from "../src/analysis/signals.js";
import { validateCandidate } from "../src/analysis/validator.js";
import { agglomerative } from "../src/analysis/cluster.js";
import { cosine, embedText } from "../src/analysis/embed.js";
import { checkSuccess, expectationMet } from "../src/runtime/check.js";
import { pagePath, redact } from "../src/util/common.js";
import { step } from "./helpers.js";

describe("severity (spec formula)", () => {
  it("is impact × (0.5 + 0.5 · affected / reached)", () => {
    expect(severity("blocked", 5, 6)).toBeCloseTo(4 * (0.5 + 0.5 * (5 / 6)), 2);
    expect(severity("minor_friction", 1, 10)).toBeCloseTo(2 * 0.55, 2);
    expect(severity("cosmetic", 3, 3)).toBe(1);
  });
  it("divides by sessions that reached the page, so late-funnel issues are not underrated", () => {
    // 3 of 3 sessions that reached checkout, even though 72 sessions ran overall.
    expect(severity("blocked", 3, 3)).toBe(4);
  });
  it("never divides by fewer sessions than were affected", () => {
    expect(severity("major_detour", 4, 2)).toBe(3);
  });
  it("labels on Nielsen's 0–4 scale", () => {
    expect(severityLabel(4)).toBe("catastrophic");
    expect(severityLabel(2.7)).toBe("major");
    expect(severityLabel(1.6)).toBe("minor");
    expect(severityLabel(1)).toBe("cosmetic");
  });
});

describe("confidence rules", () => {
  it("high: deterministic signal + 2+ personas + repeated across runs", () => {
    expect(confidence({ signalTypes: ["dead_click"], personas: 2, sessions: 4, repetitionsHit: 2, personaPassedElsewhere: false }).level).toBe("high");
  });
  it("medium: repeated across sessions or personas without the full high bar", () => {
    expect(confidence({ signalTypes: [], personas: 2, sessions: 2, repetitionsHit: 1, personaPassedElsewhere: false }).level).toBe("medium");
  });
  it("low + needs review: one session only", () => {
    expect(confidence({ signalTypes: ["dead_click"], personas: 1, sessions: 1, repetitionsHit: 1, personaPassedElsewhere: false })).toEqual({ level: "low", needsReview: true });
  });
  it("low + needs review: same persona passed on other repetitions", () => {
    expect(confidence({ signalTypes: ["layout"], personas: 1, sessions: 2, repetitionsHit: 2, personaPassedElsewhere: true }).needsReview).toBe(true);
  });
});

describe("deterministic signals", () => {
  it("dead click: no DOM change, navigation or network", () => {
    const sigs = detectSignals([step({ obs: { domChanged: false, networkCalls: 0 } })], null);
    expect(sigs.map((s) => s.type)).toContain("dead_click");
  });
  it("clicking into a text field is not a dead click", () => {
    const s = step({ obs: { domChanged: false }, target: { mark: 2, selector: "#q", name: "Search", role: "searchbox", box: { x: 0, y: 0, width: 10, height: 10 } } });
    expect(detectSignals([s], null).map((x) => x.type)).not.toContain("dead_click");
  });
  it("rage click: 3 consecutive activations of the same element", () => {
    const steps = [0, 1, 2].map((i) => step({ idx: i, obs: { domChanged: false } }));
    expect(detectSignals(steps, null).filter((s) => s.type === "rage_click")).toHaveLength(1);
  });
  it("expectation mismatch is logged even when nothing else fires", () => {
    expect(detectSignals([step({ obs: { expectationMet: false } })], null).map((s) => s.type)).toContain("expectation_mismatch");
  });
  it("loop: same page-state hash 3 times", () => {
    const steps = [0, 1, 2].map((i) => step({ idx: i, stateHash: "same", action: { type: "scroll", direction: "down" }, target: null }));
    expect(detectSignals(steps, null).map((s) => s.type)).toContain("loop");
  });
  it("scroll hunt: 4+ scrolls on one page", () => {
    const steps = [0, 1, 2, 3].map((i) => step({ idx: i, action: { type: "scroll", direction: "down" }, target: null }));
    expect(detectSignals(steps, null).map((s) => s.type)).toContain("scroll_hunt");
  });
  it("search miss, error shown, layout covered, no accessible name", () => {
    const s = step({
      obs: { searchZeroResults: true, validationMessages: ["Phone is invalid"], targetCovered: true },
      target: { mark: 3, selector: "button.icon", name: "", role: "button", box: { x: 0, y: 0, width: 10, height: 10 } },
    });
    const types = detectSignals([s], null).map((x) => x.type);
    expect(types).toEqual(expect.arrayContaining(["search_miss", "error_shown", "layout", "accessibility"]));
  });
  it("keyboard trap: many Tabs while focus stays within two elements", () => {
    const steps = [0, 1, 2, 3].map((i) => step({ idx: i, action: { type: "press", key: "Tab", times: 2 }, target: null, obs: { focusedAfter: i % 2 ? "#a" : "#b" } }));
    expect(detectSignals(steps, null).some((s) => s.type === "accessibility" && (s.details as { kind: string }).kind === "keyboard_trap")).toBe(true);
  });
  it("give-up and failure come from the session outcome", () => {
    expect(detectSignals([step()], { status: "gave_up", detail: "too hard" }).map((s) => s.type)).toContain("give_up");
    expect(detectSignals([step()], { status: "timed_out" }).map((s) => s.type)).toContain("task_failed");
  });
});

describe("no evidence, no issue (validator)", () => {
  const s1 = step({ idx: 1, thinkAloud: "I tapped Checkout but nothing happened at all.", obs: { domChanged: false } });
  const signals = detectSignals([s1], null);
  const names = new Map([[s1.id, ["Checkout", "Continue shopping"]]]);
  const draft = { title: "Checkout does nothing", description: "", page: "/bag", element: "Checkout", heuristic: "visibility_of_system_status" as const, impact: "blocked" as const, step_ids: [s1.id], quotes: ["nothing happened at all"] };

  it("accepts a candidate with real steps, a visible element and a signal", () => {
    const v = validateCandidate(draft, [s1], signals, names);
    expect(v.ok).toBe(true);
    expect(v.verifiedQuotes[0].stepId).toBe(s1.id);
  });
  it("rejects step ids that do not exist", () => {
    expect(validateCandidate({ ...draft, step_ids: ["stp_made_up"] }, [s1], signals, names).ok).toBe(false);
  });
  it("rejects elements that are not in the cited steps (hallucinated UI)", () => {
    const v = validateCandidate({ ...draft, element: "Gift wrapping toggle" }, [s1], signals, names);
    expect(v.ok).toBe(false);
    expect(v.reasons.join()).toMatch(/does not appear/);
  });
  it("rejects a candidate with neither a signal nor a verbatim quote", () => {
    const quiet = step({ idx: 2, thinkAloud: "Looks fine.", obs: { domChanged: true, networkCalls: 1 } });
    const v = validateCandidate({ ...draft, step_ids: [quiet.id], quotes: ["the colours are ugly"] }, [quiet], [], new Map([[quiet.id, ["Checkout"]]]));
    expect(v.ok).toBe(false);
    expect(v.reasons.join()).toMatch(/no signal or verbatim quote/);
  });
});

describe("clustering", () => {
  const mk = (title: string, page: string, element: string) => ({ title, page, element, embedding: embedText(`${title} ${page} ${element}`) });
  it("groups the same problem phrased differently and keeps different problems apart", () => {
    const items = [
      mk("Checkout button hidden behind cookie banner", "/bag", "Checkout"),
      mk("Cookie banner covers the checkout button on mobile", "/bag", "Checkout"),
      mk("Can't tap Checkout, banner in the way", "/bag", "Checkout"),
      mk("Search returns no results for gift", "/search", "Search"),
    ];
    const clusters = agglomerative(items);
    expect(clusters).toHaveLength(2);
    expect(clusters.find((c) => c.length === 3)).toBeDefined();
  });
  it("embeddings are deterministic and normalised", () => {
    const a = embedText("add to bag does nothing");
    expect(cosine(a, embedText("add to bag does nothing"))).toBeCloseTo(1, 5);
  });
});

describe("check stage", () => {
  const snap = (over: Partial<Parameters<typeof expectationMet>[1]> = {}) => ({ url: "http://x/a", bodyText: "Bag (0)", dialogOpen: false, focused: null, marked: {}, ...over });
  it("evaluates expectation predicates in code", () => {
    expect(expectationMet({ type: "url_changes" }, snap(), snap({ url: "http://x/b" }))).toBe(true);
    expect(expectationMet({ type: "text_appears", value: "Bag (1)" }, snap(), snap())).toBe(false);
    expect(expectationMet({ type: "text_changes", mark: 3 }, snap({ marked: { 3: { text: "Bag (0)", html: "", value: null } } }), snap({ marked: { 3: { text: "Bag (0)", html: "", value: null } } }))).toBe(false);
    expect(expectationMet({ type: "dialog_opens" }, snap(), snap({ dialogOpen: true }))).toBe(true);
    expect(expectationMet({ type: "none" }, snap(), snap())).toBeNull();
  });
  it("checks success independently of the agent: URL, text or network", () => {
    const net = [{ stepId: null, method: "POST", url: "http://x/api/orders", status: 201, resourceType: "fetch", startedAt: 0, durationMs: 1, failed: false }];
    expect(checkSuccess({ mode: "any", network: { method: "POST", url_pattern: "/api/orders", status: 201 } }, { url: "http://x/", bodyText: "", network: net }).success).toBe(true);
    expect(checkSuccess({ mode: "all", url_pattern: "/order/", text_present: "Order confirmed" }, { url: "http://x/order/KC1", bodyText: "nope", network: [] }).success).toBe(false);
    expect(checkSuccess({ mode: "any" }, { url: "", bodyText: "", network: [] }).success).toBe(false);
  });
});

describe("utilities", () => {
  it("collapses ids in page paths", () => {
    expect(pagePath("http://x/products/12")).toBe("/products/:id");
    expect(pagePath("http://x/order/KC123456")).toBe("/order/:id");
    expect(pagePath("http://x/checkout?mode=guest")).toBe("/checkout");
  });
  it("redacts emails, phone numbers and card numbers", () => {
    expect(redact("mail sam@example.com or call +1 (555) 123-4567, card 4242 4242 4242 4242")).toBe("mail [email] or call [phone], card [card]");
  });
});

describe("validator edge cases", () => {
  it("accepts symbol-only element names verbatim", () => {
    const s = step({ idx: 9, obs: { domChanged: false }, target: { mark: 4, selector: "span.close-x", name: "×", role: "generic", box: { x: 0, y: 0, width: 10, height: 10 } } });
    const sigs = detectSignals([s], null);
    const v = validateCandidate({ title: "Close does nothing", description: "", page: "/", element: "×", heuristic: "user_control_and_freedom", impact: "minor_friction", step_ids: [s.id], quotes: [] }, [s], sigs, new Map([[s.id, ["×"]]]));
    expect(v.ok).toBe(true);
  });
});

describe("new detectors", () => {
  it("flags content that moved under the tap, slow responses with no progress, and load-time shift", () => {
    const s = step({ obs: { targetMoved: { dx: 0, dy: 72 }, slowRequest: { url: "http://x/api/orders", method: "POST", ms: 3600, domChangedWhileWaiting: false }, loadShift: 0.06 } });
    const sigs = detectSignals([s], null);
    expect(sigs.some((x) => x.type === "layout" && (x.details as { kind: string }).kind === "moved_before_tap")).toBe(true);
    expect(sigs.some((x) => x.type === "layout" && (x.details as { kind: string }).kind === "load_shift")).toBe(true);
    const slow = sigs.find((x) => x.type === "slow_response");
    expect(slow?.details).toMatchObject({ ms: 3600, progressShown: false });
  });
});
