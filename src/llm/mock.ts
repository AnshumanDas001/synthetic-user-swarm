// Deterministic offline step policy, used when SWARM_MODEL_MODE=mock (tests, CI, no API key).
// It is deliberately simple: keyword matching between the task and element names. It exercises the
// whole pipeline (perception, actions, evidence, signals, analysis, report) without spending tokens.
import type { AgentStepOutput, MarkedElement } from "../types.js";
import type { PageView } from "../runtime/perception.js";
import { tokens } from "../analysis/embed.js";

const PROGRESS = [
  "add to bag", "add to cart", "view bag", "bag", "cart", "checkout", "check out", "continue as guest", "guest",
  "continue", "next", "place order", "pay", "submit", "sign up", "create account", "register",
];
// Words that only count as progress when the goal itself mentions them.
const GOAL_ONLY = ["subscribe", "newsletter", "search", "coupon"];
const DISMISS = /^(close|×|x|no thanks|dismiss|accept|accept all|got it|ok|not now|maybe later)$/i;
const DONE_TEXT = /(order confirmed|thank you for your order|you're subscribed|account created|welcome,)/i;

const FIELD_VALUES: [RegExp, string][] = [
  [/e-?mail/i, "sam.tester@example.com"],
  [/phone|mobile|tel/i, "5551234567"],
  [/first/i, "Sam"],
  [/last|surname/i, "Tester"],
  [/name/i, "Sam Tester"],
  [/address|street/i, "1 Test Street"],
  [/city|town/i, "Springfield"],
  [/zip|post/i, "12345"],
  [/card number|card/i, "4242424242424242"],
  [/expir|mm/i, "12/30"],
  [/cvc|cvv|security/i, "123"],
  [/password/i, "Correct-Horse-9"],
  [/search/i, "gift"],
  [/coupon|promo|code/i, "WELCOME10"],
];

export interface MockMemory {
  clicked: Map<string, number>;
  typed: Set<string>;
  failures: number;
  scrolls: number;
}

export function newMockMemory(): MockMemory {
  return { clicked: new Map(), typed: new Set(), failures: 0, scrolls: 0 };
}

export function mockStep(view: PageView, goal: string, mem: MockMemory, opts: { keyboardOnly: boolean; touch: boolean; lastFailed: boolean }): AgentStepOutput {
  if (opts.lastFailed) mem.failures++;
  const frustration = Math.min(10, mem.failures * 2);
  const click = (e: MarkedElement, why: string): AgentStepOutput => {
    mem.clicked.set(e.name, (mem.clicked.get(e.name) ?? 0) + 1);
    const isLink = e.role === "link";
    return {
      think_aloud: why,
      confidence: Math.max(1, 4 - mem.failures),
      frustration,
      action: opts.touch ? { type: "tap", mark: e.mark } : { type: "click", mark: e.mark },
      expectation: isLink
        ? { says: `A new page opens for "${e.name}"`, check: { type: "url_changes" } }
        : { says: `Something visibly changes after pressing "${e.name}"`, check: { type: "element_changes", mark: e.mark } },
    };
  };

  const body = view.blocks.map((b) => b.text).join(" ");
  if (DONE_TEXT.test(body)) {
    return { think_aloud: "It looks like I'm done.", confidence: 5, frustration, action: { type: "done", claim: body.match(DONE_TEXT)![0] }, expectation: { says: "Nothing more to do", check: { type: "none" } } };
  }
  if (mem.failures >= 6) {
    return { think_aloud: "I've tried everything I can think of. I give up.", confidence: 1, frustration: 10, action: { type: "give_up", reason: "could not find a way forward" }, expectation: { says: "I stop", check: { type: "none" } } };
  }

  if (opts.keyboardOnly) {
    const focused = view.elements.find((e) => String(e.mark) === view.focused);
    if (focused && score(focused, goal, mem) > 2) {
      mem.clicked.set(focused.name, (mem.clicked.get(focused.name) ?? 0) + 1);
      return { think_aloud: `Focus is on "${focused.name}", I'll press Enter.`, confidence: 3, frustration, action: { type: "press", key: "Enter" }, expectation: { says: "Something happens", check: { type: "url_changes" } } };
    }
    return { think_aloud: "Moving focus forward.", confidence: 2, frustration, action: { type: "press", key: "Tab" }, expectation: { says: "Focus moves", check: { type: "focus_moves" } } };
  }

  if (view.dialogOpen) {
    const close = view.elements.find((e) => DISMISS.test(e.name.trim()) && e.inView && !e.covered);
    if (close && (mem.clicked.get(close.name) ?? 0) < 3) return click(close, "A pop-up. I'll close it.");
  }

  // Fill fields that serve the goal; leave newsletter, coupon and search boxes alone unless the goal asks.
  const wantsSearch = /search/i.test(goal) && ![...mem.typed].some((k) => /search/i.test(k));
  const field = view.elements.find((e) => (e.role === "textbox" || e.role === "searchbox") && !e.state.some((s) => s.startsWith("value=")) && !mem.typed.has(fieldKey(e)) && e.inView &&
    (e.role === "searchbox" || /search/i.test(e.name) ? wantsSearch : !/newsletter|subscribe|coupon|promo/i.test(e.name) || /newsletter|subscribe|coupon|promo/i.test(goal)));
  if (field) {
    const value = field.role === "searchbox" || /search/i.test(field.name) ? searchQuery(goal) : FIELD_VALUES.find(([re]) => re.test(field.name))?.[1] ?? "test";
    mem.typed.add(fieldKey(field));
    return {
      think_aloud: `I'll fill in "${field.name || "this box"}".`,
      confidence: 3,
      frustration,
      action: { type: "type", mark: field.mark, text: value, submit: field.role === "searchbox" },
      expectation: { says: "My text appears in the box", check: { type: "element_changes", mark: field.mark } },
    };
  }

  const ranked = view.elements
    .filter((e) => !e.state.includes("disabled") && !["textbox", "searchbox", "combobox"].includes(e.role))
    .map((e) => ({ e, s: score(e, goal, mem) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s);
  if (ranked.length && ranked[0].s >= 2) return click(ranked[0].e, `"${ranked[0].e.name}" looks like the way forward.`);

  if (view.scroll.y < view.scroll.max - 5 && mem.scrolls < 6) {
    mem.scrolls++;
    return { think_aloud: "I can't see what I need. Let me scroll.", confidence: 2, frustration, action: { type: "scroll", direction: "down" }, expectation: { says: "More of the page shows", check: { type: "none" } } };
  }
  mem.failures++;
  if (ranked.length) return click(ranked[0].e, `Maybe "${ranked[0].e.name}"?`);
  return { think_aloud: "I'm lost. Going back.", confidence: 1, frustration, action: { type: "back" }, expectation: { says: "The previous page", check: { type: "url_changes" } } };
}

function searchQuery(goal: string): string {
  const m = /(gift|present|scarf|mug|candle|earbuds|game)[^.,]*/i.exec(goal);
  return m ? m[0].split(" ").slice(0, 4).join(" ") : "gift";
}

function fieldKey(e: MarkedElement): string {
  return `${e.name}|${e.selector}`;
}

function score(e: MarkedElement, goal: string, mem: MockMemory): number {
  const name = e.name.toLowerCase();
  if (!name) return 0;
  let s = 0;
  const pi = PROGRESS.findIndex((p) => name.includes(p));
  if (pi >= 0) s += 3 + pi * 0.2;
  if (GOAL_ONLY.some((w) => name.includes(w) && !goal.toLowerCase().includes(w))) s -= 3;
  const g = new Set(tokens(goal));
  for (const t of tokens(name)) if (g.has(t)) s += 1.5;
  if (e.role === "link" && /product|gift|mug|scarf|candle/i.test(name) && /gift|buy|product/i.test(goal)) s += 1;
  s -= (mem.clicked.get(e.name) ?? 0) * 2.5;
  if (!e.inView) s -= 0.5;
  return s;
}
