// Browser agent runtime: perceive -> think -> act -> check, one action per step, until done, give_up,
// budget, or loop detection. Every step writes its evidence before the next action runs.
import { z } from "zod";
import type { Page } from "playwright";
import { config } from "../config.js";
import {
  AgentAction, ExpectationCheck, type ActionProfile, type AgentStepOutput, type PersonaBudget, type PersonaCard,
  type PerceptionProfile, type StepObservation, type StepRecord, type TaskSpec,
} from "../types.js";
import { describeView, perceive, type PageView } from "./perception.js";
import { act, allowedActions } from "./actions.js";
import { checkSuccess, estimateHumanMs, expectationMet, marksFor, snapshot } from "./check.js";
import { AXE_SOURCE, type Sandbox } from "./sandbox.js";
import { imageBlock, isFatal, isRetryable, RefusalError, SchemaError, structured, textBlock } from "../llm/client.js";
import { JUDGE_SYSTEM, personaSystemPrompt, stepPrompt, type HistoryItem } from "../llm/prompts.js";
import { mockStep, newMockMemory } from "../llm/mock.js";
import { newId, pagePath, redact, sleep } from "../util/common.js";
import type { BlobStore } from "../store/blobs.js";
import type { AxeViolation } from "../store/db.js";
import { robotsBlocks, type RobotsRules } from "./robots.js";

// LLM-facing step schema: same shape as AgentStepOutput but without numeric range constraints,
// which are clamped after parsing so a frustration of 11 never fails a step.
const StepLlm = z.object({
  think_aloud: z.string(),
  confidence: z.number(),
  frustration: z.number(),
  action: AgentAction,
  expectation: z.object({ says: z.string(), check: ExpectationCheck }),
  note: z.string().optional(),
});

export type SessionEnd =
  | { status: "succeeded"; detail: string }
  | { status: "gave_up"; detail: string }
  | { status: "failed"; detail: string }
  | { status: "timed_out"; detail: string }
  | { status: "infra_error"; detail: string };

export interface AgentHooks {
  onStep(step: StepRecord, view: PageView): void | Promise<void>;
  onAudit(step: StepRecord, violations: AxeViolation[]): void;
  costGuard(): boolean; // false once the study's cost cap is reached
}

export interface RunArgs {
  sessionId: string;
  studyId: string;
  card: PersonaCard;
  task: TaskSpec;
  startUrl: string;
  perception: PerceptionProfile;
  actionProfile: ActionProfile;
  budget: PersonaBudget;
  sandbox: Sandbox;
  blobs: BlobStore;
  hooks: AgentHooks;
  resumeFrom?: StepRecord[];
  robots?: RobotsRules | null;
}

export const COST_CAP_DETAIL = "study cost cap reached";

export class InfraError extends Error {}
export class FatalError extends Error {}

export async function runAgent(args: RunArgs): Promise<{ end: SessionEnd; steps: StepRecord[]; tokens: number; cost: number }> {
  const { card, task, sandbox, blobs, hooks, perception: perc, actionProfile: actProf, budget } = args;
  const page = sandbox.page;
  const screenReader = perc.screenshot === "none";
  const allowed = allowedActions(actProf, screenReader);
  const system = personaSystemPrompt(card, task, allowed);
  const steps: StepRecord[] = [...(args.resumeFrom ?? [])];
  const history: HistoryItem[] = steps.slice(-config.historySteps).map(toHistory);
  const notes: string[] = [];
  const mem = newMockMemory();
  const auditedPages = new Set<string>();
  const t0 = Date.now();
  let tokens = 0;
  let cost = 0;
  let escalateLeft = 0;
  let cooldown = 0;
  let lastImageHash: string | null = null;
  let obstacleAttempts = 0;
  let lastError: string | undefined;
  let lastStateHash: string | null = steps.at(-1)?.stateHash ?? null;
  let lastCls = 0;

  // Durable resume: return to where the last recorded step left the persona.
  await gotoWithBackoff(page, steps.at(-1)?.url ?? args.startUrl);

  for (let idx = steps.length; ; idx++) {
    if (idx >= budget.maxSteps) return finish({ status: "failed", detail: `step budget of ${budget.maxSteps} reached` });
    if (Date.now() - t0 > budget.wallClockMs) return finish({ status: "timed_out", detail: "wall-clock budget reached" });
    if (tokens > budget.maxTokens) return finish({ status: "failed", detail: "token budget reached" });
    if (!hooks.costGuard()) return finish({ status: "infra_error", detail: COST_CAP_DETAIL });

    const stepId = newId("stp");
    sandbox.currentStepId = stepId;
    const startedAt = Date.now();

    // ---------------- perceive
    const view = await perceive(page, perc);
    const prefix = `${args.studyId}/${args.sessionId}/${String(idx).padStart(3, "0")}`;
    const artifacts: Record<string, string> = {};
    if (view.shotClean) artifacts.before = blobs.put(prefix, view.shotClean, "jpg");
    if (view.shotMarked) artifacts.before_marked = blobs.put(prefix, view.shotMarked, "jpg");
    if (view.shotModel && view.shotModel !== view.shotMarked) artifacts.model_view = blobs.put(prefix, view.shotModel, "jpg");
    artifacts.elements = blobs.put(prefix, JSON.stringify(view.elements), "json");
    if (view.ariaSnapshot) artifacts.a11y = blobs.put(prefix, view.ariaSnapshot, "yaml");
    // Visible text, so issues about copy (jargon, unclear labels) can cite what was on screen.
    artifacts.text = blobs.put(prefix, JSON.stringify(view.blocks), "json");
    // Layout shift since this page loaded, measured before acting: content that jumped on arrival.
    const arrivedHere = steps.at(-1)?.pagePath !== pagePath(view.url) || steps.at(-1)?.observation.navigated;
    const loadShift = arrivedHere ? ((await page.evaluate("window.__sus ? window.__sus.counters().lateCls : 0").catch(() => 0)) as number) : 0;

    // Accessibility audit on each new page (axe-core).
    const pp = pagePath(view.url);
    let violations: AxeViolation[] | null = null;
    if (!auditedPages.has(pp)) {
      auditedPages.add(pp);
      violations = await runAxe(page);
      if (violations) artifacts.axe = blobs.put(prefix, JSON.stringify(violations), "json");
    }

    // Loop detection: the same page state three times in a row while repeating the same action ends the
    // session. A persona trying different things on an unchanged page is stopped by the retry cap instead.
    const lastTwo = steps.slice(-2);
    if (lastTwo.length === 2 && lastTwo.every((s) => s.stateHash === view.stateHash) && sameAction(lastTwo[0], lastTwo[1])) {
      return finish({ status: "failed", detail: "loop detected (same page state 3 times, same action repeated)" });
    }

    // ---------------- think
    const changed = lastStateHash !== view.stateHash;
    const viewText = describeView(view, { screenReader, keyboardOnly: actProf.keyboardOnly, changed });
    // Model routing: when the agent is stuck it thinks harder (higher effort, or a stronger model if one
    // is configured) for a few steps, then drops back and must cool down before escalating again.
    const stuck = obstacleAttempts >= 2 || (steps.at(-1)?.frustration ?? 0) >= 7;
    if (stuck && escalateLeft === 0 && cooldown === 0) escalateLeft = config.escalationSteps;
    const escalated = escalateLeft > 0;
    const model = card.model ?? (escalated ? config.models.escalation : config.models.step);
    if (escalateLeft > 0) {
      escalateLeft--;
      if (escalateLeft === 0) cooldown = config.escalationSteps;
    } else if (cooldown > 0) cooldown--;

    let decision: AgentStepOutput;
    let usage = { tokensIn: 0, tokensOut: 0, costUsd: 0, model: "mock" };
    if (config.modelMode === "mock") {
      decision = mockStep(view, task.goal, mem, { keyboardOnly: actProf.keyboardOnly && !screenReader, touch: actProf.touch, lastFailed: obstacleAttempts > 0 });
    } else {
      // Cost lever: no screenshot when the page has not changed since the last one the model saw.
      const sendImage = !!view.shotModel && view.stateHash !== lastImageHash;
      if (sendImage) lastImageHash = view.stateHash;
      const content = [
        ...(sendImage ? [imageBlock(view.shotModel!)] : []),
        textBlock(`${!sendImage && view.shotModel ? "(The screen looks exactly as it did on your previous step, so no new screenshot.)\n\n" : ""}${stepPrompt({ view: viewText, history: history.slice(-config.historySteps), notes, stepsLeft: budget.maxSteps - idx, obstacleAttempts, lastError })}`),
      ];
      const effort = escalated ? config.effort.escalation : config.effort.step;
      let wasted = 0;
      try {
        const res = await callWithRetry(() => structured({ model, schema: StepLlm, system, content, effort, maxTokens: 4000, name: "agent_step" }), (u) => { wasted += u; });
        decision = {
          ...res.value,
          think_aloud: redact(res.value.think_aloud),
          confidence: Math.round(Math.min(5, Math.max(1, res.value.confidence))),
          frustration: Math.round(Math.min(10, Math.max(0, res.value.frustration))),
        };
        usage = { ...res.usage, costUsd: res.usage.costUsd + wasted };
      } catch (e) {
        if (e instanceof RefusalError) return finish({ status: "infra_error", detail: e.message });
        if (isFatal(e)) throw new FatalError(`OpenRouter stopped the run: ${(e as Error).message.split("\n")[0]}`);
        throw new InfraError(`step model failed: ${(e as Error).message}`);
      }
    }
    tokens += usage.tokensIn + usage.tokensOut;
    cost += usage.costUsd;
    if (decision.note) notes.push(decision.note.slice(0, 160));
    if (notes.length > 8) notes.shift();

    // ---------------- act
    const before = await snapshot(page, marksFor(decision.expectation.check), view.dialogOpen, view.focused);
    await page.evaluate("window.__sus && window.__sus.resetCounters()").catch(() => {});
    const netBefore = sandbox.network.length;
    const consoleBefore = sandbox.console.length;
    const actedAt = Date.now();
    let res: Awaited<ReturnType<typeof act>>;
    try {
      res = await act(page, decision.action, view.elements, actProf, {
        screenReader, allowIrreversible: task.allow_irreversible, focusedMark: view.focused,
      });
    } catch (e) {
      res = { error: (e as Error).message.split("\n")[0], charsTyped: 0 };
    }

    // ---------------- check (pure code)
    await settle(page);
    // Slow response: a request this action started is still running after the settle window.
    // Wait for it (up to 8 s) and note whether the page showed any progress meanwhile.
    let slowRequest: StepObservation["slowRequest"];
    const pendingReq = [...sandbox.inflight.values()].filter((r) => r.startedAt >= actedAt - 50);
    if (pendingReq.length) {
      const r = pendingReq[0];
      await page.evaluate("window.__sus && window.__sus.resetCounters()").catch(() => {});
      const waitStart = Date.now();
      while ([...sandbox.inflight.values()].includes(r) && Date.now() - waitStart < 8000) await sleep(200);
      const during = (await page.evaluate("window.__sus ? window.__sus.counters().mutations : 0").catch(() => 0)) as number;
      const ms = Date.now() - r.startedAt;
      if (ms >= 2000) slowRequest = { url: r.url, method: r.method, ms, domChangedWhileWaiting: during > 0 };
      await settle(page);
    }
    const counters = (await page.evaluate("window.__sus ? window.__sus.counters() : {mutations:0,cls:0}").catch(() => ({ mutations: 0, cls: 0 }))) as { mutations: number; cls: number };
    const afterView = await quickState(page);
    const after = await snapshot(page, marksFor(decision.expectation.check), afterView.dialogOpen, afterView.focused);
    const newNet = sandbox.network.slice(netBefore).filter((n) => n.startedAt <= actedAt + 1000 && !/image|font|media/.test(n.resourceType));
    const navigated = before.url.split("#")[0] !== after.url.split("#")[0];
    const isActive = !["give_up", "done", "wait"].includes(decision.action.type);
    const met = isActive && !res.error && !res.blockedByPolicy ? expectationMet(decision.expectation.check, before, after) : null;

    const observation: StepObservation = {
      urlBefore: before.url,
      urlAfter: after.url,
      navigated,
      domChanged: counters.mutations > 0 || navigated,
      networkCalls: newNet.length,
      networkErrors: sandbox.network.slice(netBefore).filter((n) => n.status >= 400 || n.failed).map((n) => ({ url: n.url, status: n.status, method: n.method })),
      consoleErrors: sandbox.console.slice(consoleBefore).map((c) => c.text),
      expectationMet: met,
      dialogOpened: !before.dialogOpen && afterView.dialogOpen,
      validationMessages: afterView.validation,
      actionError: res.error,
      targetCovered: res.targetCovered,
      primaryActionOffscreen: res.scrolledIntoView && !!res.target && /checkout|pay|place order|continue|submit|buy|add to/i.test(res.target.name),
      searchZeroResults: afterView.searchZeroResults,
      wordsSeen: view.wordsSeen,
      layoutShift: Math.max(0, counters.cls - lastCls),
      focusChanged: before.focused !== afterView.focused,
      focusedAfter: afterView.focusedSelector,
      scrolledIntoView: res.scrolledIntoView,
      blockedByPolicy: res.blockedByPolicy,
      loadShift: loadShift > 0 ? Number(loadShift.toFixed(3)) : undefined,
      targetMoved: res.targetMoved,
      slowRequest,
    };
    lastCls = counters.cls;

    const shotAfter = await page.screenshot({ type: "jpeg", quality: 70, scale: "css", timeout: 15_000 }).catch(() => null);
    if (shotAfter) artifacts.after = blobs.put(prefix, shotAfter, "jpg");

    const step: StepRecord = {
      id: stepId,
      sessionId: args.sessionId,
      idx,
      url: view.url,
      pagePath: pp,
      title: view.title,
      stateHash: view.stateHash,
      action: decision.action,
      thinkAloud: decision.think_aloud,
      expectation: decision.expectation,
      confidence: decision.confidence,
      frustration: decision.frustration,
      target: res.target ? { mark: res.target.mark, selector: res.target.selector, name: res.target.name, role: res.target.role, box: res.target.box, vbox: res.target.vbox } : null,
      observation,
      artifacts,
      tokensIn: usage.tokensIn,
      tokensOut: usage.tokensOut,
      costUsd: usage.costUsd,
      model: usage.model,
      estHumanMs: estimateHumanMs(card, decision.action, view.wordsSeen, res.charsTyped),
      startedAt,
      endedAt: Date.now(),
    };
    steps.push(step);
    await hooks.onStep(step, view);
    if (violations) hooks.onAudit(step, violations);

    // Obstacle tracking: consecutive steps that made no visible progress.
    const progressed = navigated || met === true || (view.stateHash !== lastStateHash && !res.error);
    obstacleAttempts = progressed ? 0 : obstacleAttempts + 1;
    lastError = res.error;
    lastStateHash = view.stateHash;
    history.push(toHistory(step));

    // Off-limits (robots.txt): an in-app route change into a disallowed path is undone, and the persona is told.
    if (robotsBlocks(args.robots, page.url())) {
      await page.goBack({ timeout: 10_000 }).catch(() => {});
      if (robotsBlocks(args.robots, page.url())) await gotoWithBackoff(page, args.startUrl);
      lastError = "that part of the site is off-limits for this study (the site asks automated visitors not to go there); try another way";
    }

    // ---------------- stop conditions
    if (res.blockedByPolicy) return finish({ status: "succeeded", detail: `reached irreversible action "${res.target?.name}" (blocked by safety policy)` });
    if (decision.action.type === "give_up") return finish({ status: "gave_up", detail: decision.action.reason });
    if (decision.action.type === "done") {
      const verdict = await verifySuccess(page, task, sandbox);
      return finish(verdict.success
        ? { status: "succeeded", detail: verdict.checks.filter((c) => c.passed).map((c) => c.kind).join(", ") }
        : { status: "failed", detail: `agent claimed "${decision.action.claim}" but success checks failed` });
    }
    // Success can also be reached without the agent noticing (checked independently every step).
    if (navigated || observation.domChanged) {
      const verdict = checkSuccess({ ...task.success, llm_judge: undefined }, { url: page.url(), bodyText: after.bodyText, network: sandbox.network });
      if (verdict.success) return finish({ status: "succeeded", detail: verdict.checks.filter((c) => c.passed).map((c) => c.kind).join(", ") });
    }
    if (obstacleAttempts > budget.maxRetriesPerObstacle + 2) {
      // Hard retry cap per obstacle (counter to over-patience bias).
      return finish({ status: "gave_up", detail: `retry cap reached at ${pp}` });
    }
  }

  function finish(end: SessionEnd) {
    return { end, steps, tokens, cost };
  }
}

function sameAction(a: StepRecord, b: StepRecord): boolean {
  return JSON.stringify(a.action) === JSON.stringify(b.action) || (!!a.target && a.target.selector === b.target?.selector && a.action.type === b.action.type);
}

function toHistory(s: StepRecord): HistoryItem {
  const a = s.action as Record<string, unknown>;
  const desc = `${s.action.type}${"mark" in a ? ` [${a.mark}]${s.target?.name ? ` "${s.target.name}"` : ""}` : ""}${"text" in a ? ` "${a.text}"` : ""}${"key" in a ? ` ${a.key}` : ""}${"direction" in a ? ` ${a.direction}` : ""}`;
  const o = s.observation;
  const result = o.actionError
    ? `failed: ${o.actionError}`
    : o.navigated
      ? `moved to ${pagePath(o.urlAfter)}`
      : o.expectationMet === false
        ? `what you expected did not happen`
        : o.domChanged
          ? "the page changed"
          : "nothing visible happened";
  return { idx: s.idx, thinkAloud: s.thinkAloud, action: desc, result };
}

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => {});
  await page.waitForTimeout(1000); // the dead-click window: DOM change, navigation or network within ~1 s
}

async function quickState(page: Page): Promise<{ dialogOpen: boolean; focused: string | null; focusedSelector: string | null; validation: string[]; searchZeroResults: boolean }> {
  const r = (await page.evaluate("window.__sus ? window.__sus.inspect() : null").catch(() => null)) as Awaited<ReturnType<typeof quickState>> | null;
  return r ?? { dialogOpen: false, focused: null, focusedSelector: null, validation: [], searchZeroResults: false };
}

async function runAxe(page: Page): Promise<AxeViolation[] | null> {
  try {
    const has = await page.evaluate("typeof window.axe !== 'undefined'");
    if (!has) await page.evaluate(AXE_SOURCE);
    const res = (await page.evaluate(`axe.run(document, { resultTypes: ['violations'] })`)) as { violations: { id: string; impact: string | null; help: string; helpUrl: string; nodes: { target: string[]; html: string }[] }[] };
    return res.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, helpUrl: v.helpUrl, nodes: v.nodes.slice(0, 10).map((n) => ({ target: n.target.map(String), html: n.html.slice(0, 300) })) }));
  } catch {
    return null;
  }
}

async function verifySuccess(page: Page, task: TaskSpec, sandbox: Sandbox) {
  const bodyText = (await page.evaluate("document.body ? document.body.innerText : ''").catch(() => "")) as string;
  let judge: { passed: boolean; detail: string } | null = null;
  if (task.success.llm_judge && config.modelMode === "live") {
    const shot = await page.screenshot({ type: "jpeg", quality: 70, scale: "css" });
    const { value } = await structured({
      model: config.models.judge,
      schema: z.object({ achieved: z.boolean(), evidence: z.string() }),
      system: JUDGE_SYSTEM,
      content: [imageBlock(shot), textBlock(`Goal: ${task.success.llm_judge}\n\nPage text (truncated):\n${bodyText.slice(0, 4000)}`)],
      effort: "low",
      name: "success_judge",
    });
    judge = { passed: value.achieved, detail: value.evidence };
  }
  return checkSuccess(task.success, { url: page.url(), bodyText, network: sandbox.network }, judge);
}

// Politeness: back off on 429/5xx for the main document; persistent failures are infra errors, not findings.
export async function gotoWithBackoff(page: Page, url: string): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch((e: Error) => e);
    if (res instanceof Error) {
      if (attempt === 3) throw new InfraError(`navigation failed: ${res.message.split("\n")[0]}`);
    } else if (res && (res.status() === 429 || res.status() >= 500)) {
      if (attempt === 3) throw new InfraError(`site returned ${res.status()} repeatedly`);
    } else return;
    await sleep(1000 * 2 ** attempt);
  }
}

// Retries transient API errors with backoff, and one malformed output (its cost is still reported).
async function callWithRetry<T>(fn: () => Promise<T>, onWasted: (usd: number) => void = () => {}): Promise<T> {
  let schemaRetries = 0;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof SchemaError && schemaRetries++ < 1) {
        onWasted(e.usage.costUsd);
        continue;
      }
      if (attempt >= 3 || !isRetryable(e)) throw e;
      await sleep(2000 * 2 ** attempt);
    }
  }
}
