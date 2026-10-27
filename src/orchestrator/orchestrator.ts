// Orchestrator and swarm scheduler. Expands a study into sessions (persona × task × repetition), runs
// each as a durable unit of work with isolation, politeness, budgets and infra-error retries, and
// streams every step to the event bus. Analysis runs incrementally as sessions finish so issues form live.
import { config, multiUser } from "../config.js";
import { Db } from "../store/db.js";
import { LocalBlobStore, type BlobStore } from "../store/blobs.js";
import { EventBus } from "../store/events.js";
import { StudySpec, TERMINAL_STATUSES, type PersonaCard, type StepRecord, type TaskSpec } from "../types.js";
import { actionProfile, contextOptions, perceptionProfile, personaBudget, isMobile } from "../personas/profiles.js";
import { dedupePersonas, loadCuratedPersonas, resolveCurated, seededPersonas, stratifiedSample } from "../personas/library.js";
import { generatePersonas } from "../personas/generator.js";
import { BrowserPool, openSandbox, type Sandbox } from "../runtime/sandbox.js";
import { COST_CAP_DETAIL, FatalError, gotoWithBackoff, InfraError, runAgent } from "../runtime/agent.js";
import { detectSignals } from "../analysis/signals.js";
import { analyseSession, issueSummary, synthesizeStudy } from "../analysis/pipeline.js";
import { preflight } from "../llm/client.js";
import { assertUrlSafe, urlIsSafe } from "../runtime/netguard.js";
import { fetchRobots, type RobotsRules } from "../runtime/robots.js";
import { hostOf, log, newId, sleep } from "../util/common.js";

const MAX_ATTEMPTS = 3;
const LEASE_MS = 60_000;

export class StudyBusyError extends Error {}

export interface SwarmDeps {
  db: Db;
  blobs: BlobStore;
  bus: EventBus;
  pool: BrowserPool;
}

export function createDeps(): SwarmDeps {
  const db = new Db();
  return { db, blobs: new LocalBlobStore(), bus: new EventBus(db), pool: new BrowserPool() };
}

// ---------------------------------------------------------------- plan

export async function planStudy(deps: SwarmDeps, rawSpec: unknown, owner: { ownerId?: string | null; keySource?: "platform" | "user" } = {}): Promise<string> {
  const spec = StudySpec.parse(rawSpec);
  const host = hostOf(spec.target_url);
  if (!spec.allowed_domains.some((d) => host === d || host.endsWith(`.${d}`))) {
    throw new Error(`target_url host "${host}" is not in allowed_domains`);
  }
  if (multiUser()) {
    // Hosted mode: every URL a study names must be public http(s); no server files as persona seeds.
    await assertUrlSafe(spec.target_url, "target_url");
    if (spec.reset_url) await assertUrlSafe(spec.reset_url, "reset_url");
    for (const t of spec.tasks) {
      if (t.start_url) await assertUrlSafe(t.start_url, `start_url of task ${t.id}`);
      for (const st of [...(t.auth ?? []), ...(t.setup ?? [])]) if (st.goto) await assertUrlSafe(st.goto, `setup step of task ${t.id}`);
    }
    if (spec.personas.seeded_from) throw new Error("seeded_from is not available on the hosted service");
  }
  const studyId = newId("study");
  const cards = await resolvePersonas(spec);
  deps.db.insertStudy(studyId, spec, owner);
  for (const card of cards) {
    deps.db.insertPersona(studyId, card, perceptionProfile(card), actionProfile(card),
      personaBudget(card, { maxSteps: spec.budget.max_steps, wallClockMinutes: spec.budget.wall_clock_minutes, tokens: spec.budget.tokens_per_session }));
  }
  // Sessions = persona × task × repetition, each repetition with its own seed.
  for (const task of spec.tasks) {
    for (const card of cards) {
      for (let rep = 0; rep < spec.budget.repetitions; rep++) {
        deps.db.insertSession({ id: newId("ses"), studyId, taskId: task.id, personaId: card.id, repetition: rep, seed: spec.seed * 1000 + rep });
      }
    }
  }
  log("plan", `${studyId}: ${cards.length} personas × ${spec.tasks.length} tasks × ${spec.budget.repetitions} reps = ${cards.length * spec.tasks.length * spec.budget.repetitions} sessions`);
  return studyId;
}

async function resolvePersonas(spec: StudySpec): Promise<PersonaCard[]> {
  const library = loadCuratedPersonas();
  let cards = resolveCurated(spec.personas, library);
  if (spec.personas.include.length === 0 && (spec.personas.generate.length || spec.personas.seeded_from)) cards = [];
  for (const g of spec.personas.generate) cards.push(...(await generatePersonas(g.segment, g.count, spec.seed)).cards);
  if (spec.personas.seeded_from) cards.push(...seededPersonas(spec.personas.seeded_from, spec.personas.size ?? 6, spec.seed));
  cards = dedupePersonas(cards);
  if (spec.personas.size) cards = stratifiedSample(cards, spec.personas.size, spec.personas.mobile_share, spec.seed);
  if (!cards.length) throw new Error("persona mix resolved to zero personas");
  return cards;
}

// ---------------------------------------------------------------- run

export interface RunOptions {
  onlyAnalyse?: boolean;
  llmMerge?: boolean;
  signal?: AbortSignal;
}

export async function runStudy(deps: SwarmDeps, studyId: string, opts: RunOptions = {}): Promise<void> {
  const { db, bus } = deps;
  const study = db.study(studyId);
  if (!study) throw new Error(`no study ${studyId}`);
  const spec = study.spec;
  const tasks = new Map(db.tasks(studyId).map((t) => [t.id, t]));
  const personas = new Map(db.personas(studyId).map((p) => [p.id, p]));

  // Credit guard: the effective cap is the study's cap or the credit left above the reserve, whichever is
  // lower, counting what this study already spent (a resumed study keeps its earlier spend).
  let capUsd = spec.budget.cost_cap_usd;
  if (!opts.onlyAnalyse && config.modelMode === "live") {
    const { remainingUsd } = await preflight([config.models.step, config.models.escalation, config.models.critic]);
    if (remainingUsd !== null) {
      const spent = db.study(studyId)?.costUsd ?? 0;
      capUsd = Math.min(capUsd, spent + remainingUsd - config.creditReserveUsd);
      log("credits", `$${remainingUsd.toFixed(2)} OpenRouter credit left; this study may spend up to $${(capUsd - spent).toFixed(2)} more (cap $${spec.budget.cost_cap_usd}, reserve $${config.creditReserveUsd})`);
    }
  }
  const cap = capUsd;
  const robots = spec.respect_robots ? await fetchRobots(spec.target_url) : null;
  if (robots?.disallow.length) log("robots", `honouring robots.txt for ${robots.host}: staying out of ${robots.disallow.join(", ")}`);

  // One runner per study, across processes: hold a lease and renew it while working. A study whose runner
  // died (lease expired) can be resumed; one that is actively running cannot be picked up twice.
  const runner = `${process.pid}:${newId("run")}`;
  if (!db.acquireStudyLease(studyId, runner, LEASE_MS)) {
    throw new StudyBusyError(`study ${studyId} is already being run by another process`);
  }
  const renew = setInterval(() => db.acquireStudyLease(studyId, runner, LEASE_MS), LEASE_MS / 3);
  try {
    await runStudyLeased(deps, studyId, opts, { spec, tasks, personas, cap, robots });
  } finally {
    clearInterval(renew);
    db.releaseStudyLease(studyId, runner);
  }
}

async function runStudyLeased(
  deps: SwarmDeps, studyId: string, opts: RunOptions,
  ctx: { spec: StudySpec; tasks: Map<string, TaskSpec>; personas: Map<string, PersonaCard>; cap: number; robots: RobotsRules | null },
): Promise<void> {
  const { db, bus } = deps;
  const { spec, tasks, personas, cap, robots } = ctx;
  // Resume: sessions left mid-flight by a crashed runner go back on the queue; their recorded steps are kept.
  for (const s of db.sessions(studyId)) {
    if (s.status === "provisioning" || s.status === "running") db.updateSession(s.id, { status: "queued" });
  }

  db.setStudyStatus(studyId, "running");
  bus.publish(studyId, "study.started", {
    name: spec.name, targetUrl: spec.target_url,
    sessions: db.sessions(studyId).map((s) => sessionInfo(s, personas.get(s.personaId)!)),
    tasks: [...tasks.values()].map((t) => ({ id: t.id, goal: t.goal })),
  });

  if (!opts.onlyAnalyse) {
    await deps.pool.warm();
    const queue = db.sessions(studyId).filter((s) => s.status === "queued");
    const concurrency = Math.min(spec.budget.concurrency, config.perDomainConcurrency);
    let stopped = false;
    let synthChain: Promise<unknown> = Promise.resolve();

    let fatal: string | null = null;
    const worker = async () => {
      for (;;) {
        if (opts.signal?.aborted || fatal) return;
        const next = queue.shift();
        if (!next) return;
        // Claim atomically: never run a session another worker already took.
        if (!db.claimSession(next.id)) continue;
        // Hard per-study cost cap: stop scheduling new sessions once reached.
        if ((db.study(studyId)?.costUsd ?? 0) >= cap) {
          if (!stopped) bus.publish(studyId, "log", { level: "warn", message: `cost cap $${cap.toFixed(2)} reached; no new sessions scheduled` });
          stopped = true;
          return;
        }
        const r = await runSessionWithRetries(deps, studyId, next.id, tasks.get(next.taskId)!, personas.get(next.personaId)!, spec, cap, robots);
        if (r === "fatal") {
          fatal = db.session(next.id)?.outcomeDetail ?? "fatal error";
          bus.publish(studyId, "log", { level: "error", message: fatal });
          log("orchestrator", `stopping study: ${fatal}`);
          return;
        }
        // Incremental analysis so issues appear and merge live as sessions finish.
        try {
          await analyseSession(db, deps.blobs, next.id);
          synthChain = synthChain.then(() => synthesizeStudy(db, studyId, { llmMerge: false, bus })).catch(() => {});
        } catch (e) {
          log("analyse", `session ${next.id} analysis failed: ${(e as Error).message}`);
        }
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
    await synthChain;
  }

  // Final analysis pass over anything not yet analysed, then synthesis with the LLM merge pass.
  for (const s of db.sessions(studyId)) {
    if (TERMINAL_STATUSES.includes(s.status) && s.status !== "analysed") {
      await analyseSession(db, deps.blobs, s.id).catch((e) => log("analyse", `${s.id}: ${(e as Error).message}`));
    }
  }
  const issues = await synthesizeStudy(db, studyId, { llmMerge: opts.llmMerge ?? true, bus });
  db.setStudyStatus(studyId, opts.signal?.aborted ? "stopped" : "complete");
  bus.publish(studyId, "study.finished", { issues: issues.map(issueSummary), costUsd: db.study(studyId)?.costUsd ?? 0 });
}

function sessionInfo(s: { id: string; taskId: string; personaId: string; repetition: number; status: string }, card: PersonaCard) {
  return {
    id: s.id, taskId: s.taskId, personaId: s.personaId, personaName: card.name, archetype: card.archetype,
    repetition: s.repetition, status: s.status, mobile: isMobile(card), viewport: contextOptions(card, "").viewport,
  };
}

async function runSessionWithRetries(deps: SwarmDeps, studyId: string, sessionId: string, task: TaskSpec, card: PersonaCard, spec: StudySpec, capUsd: number, robots: RobotsRules | null): Promise<"ok" | "fatal"> {
  const { db, bus } = deps;
  for (;;) {
    const row = db.session(sessionId)!;
    const attempt = row.attempts + 1;
    db.updateSession(sessionId, { status: "provisioning", attempts: attempt, startedAt: row.startedAt ?? Date.now() });
    bus.publish(studyId, "session.status", { sessionId, status: "provisioning", attempt });
    const result = await runSessionOnce(deps, studyId, sessionId, task, card, spec, capUsd, robots);
    if (result === "ok") return "ok";
    // Infra failures are retried and never counted as usability issues.
    if (attempt >= MAX_ATTEMPTS || result.fatal || result.noRetry) {
      db.updateSession(sessionId, { status: "infra_error", outcome: "infra_error", outcomeDetail: result.error, endedAt: Date.now() });
      bus.publish(studyId, "session.status", { sessionId, status: "infra_error", detail: result.error });
      return result.fatal ? "fatal" : "ok";
    }
    log("orchestrator", `${sessionId} infra error (attempt ${attempt}): ${result.error}; retrying`);
    await sleep(1500 * attempt);
  }
}

async function runSessionOnce(deps: SwarmDeps, studyId: string, sessionId: string, task: TaskSpec, card: PersonaCard, spec: StudySpec, capUsd: number, robots: RobotsRules | null): Promise<"ok" | { error: string; fatal?: boolean; noRetry?: boolean }> {
  const { db, blobs, bus, pool } = deps;
  let sandbox: Sandbox | null = null;
  try {
    // Determinism: reset site state between sessions (seeded accounts, emptied carts).
    if (spec.reset_url && (await urlIsSafe(spec.reset_url))) await fetch(spec.reset_url, { method: "POST", redirect: "manual" }).catch(() => {});

    sandbox = await openSandbox(pool, card, spec.allowed_domains, robots);
    const startUrl = task.start_url ?? spec.target_url;

    // Auth outside the model: scripted login with secrets from the vault (env vars). The LLM never sees them.
    if (task.auth?.length || task.setup?.length) await runScriptSteps(sandbox, [...(task.auth ?? []), ...(task.setup ?? [])]);

    db.updateSession(sessionId, { status: "running" });
    bus.publish(studyId, "session.status", { sessionId, status: "running" });
    const resumeFrom = db.steps(sessionId);

    const perception = perceptionProfile(card);
    const action = actionProfile(card);
    const budget = personaBudget(card, { maxSteps: spec.budget.max_steps, wallClockMinutes: spec.budget.wall_clock_minutes, tokens: spec.budget.tokens_per_session });
    const sessionSteps: StepRecord[] = [...resumeFrom];
    let sessionCost = resumeFrom.reduce((s, x) => s + x.costUsd, 0);
    let sessionTokens = resumeFrom.reduce((s, x) => s + x.tokensIn + x.tokensOut, 0);
    let seenSignals = new Set(detectSignals(sessionSteps, null).map((s) => s.id));

    const { end } = await runAgent({
      sessionId, studyId, card, task, startUrl, perception, actionProfile: action, budget, sandbox, blobs, resumeFrom, robots,
      hooks: {
        onStep: (step, view) => {
          // Immutable step record lands before the next action runs.
          db.insertStep(step);
          sessionSteps.push(step);
          sessionCost += step.costUsd;
          sessionTokens += step.tokensIn + step.tokensOut;
          const studyCost = db.addStudyCost(studyId, step.costUsd);
          db.updateSession(sessionId, { stepCount: sessionSteps.length, cost: sessionCost, tokens: sessionTokens, estHumanMs: sessionSteps.reduce((s, x) => s + x.estHumanMs, 0) });
          bus.publish(studyId, "session.step", {
            sessionId, idx: step.idx, stepId: step.id, url: step.url, pagePath: step.pagePath, title: step.title,
            thinkAloud: step.thinkAloud, action: step.action, target: step.target?.name ?? null, frustration: step.frustration,
            confidence: step.confidence, expectation: step.expectation.says, expectationMet: step.observation.expectationMet,
            shot: step.artifacts.before_marked ?? step.artifacts.before ?? null, clean: step.artifacts.before ?? null, after: step.artifacts.after ?? null,
            costUsd: step.costUsd, elements: view.elements.length,
          });
          bus.publish(studyId, "study.cost", { costUsd: studyCost });
          // Live signals for the journey map and focus view.
          const sigs = detectSignals(sessionSteps, null);
          for (const s of sigs) {
            if (seenSignals.has(s.id)) continue;
            bus.publish(studyId, "session.signal", { sessionId, stepId: s.stepId, type: s.type, details: s.details, pagePath: sessionSteps.find((x) => x.id === s.stepId)?.pagePath });
          }
          seenSignals = new Set(sigs.map((s) => s.id));
        },
        onAudit: (step, violations) => db.upsertAudit(studyId, step.pagePath, sessionId, step.id, violations),
        costGuard: () => (db.study(studyId)?.costUsd ?? 0) < capUsd,
      },
    });

    // Session-level evidence: rrweb stream, console, network (HAR-like, sliced by step id), Playwright trace.
    await sandbox.page.waitForTimeout(500).catch(() => {});
    const prefix = `${studyId}/${sessionId}/session`;
    const artifacts: Record<string, string> = {
      rrweb: blobs.put(prefix, JSON.stringify(sandbox.rrweb), "json"),
      console: blobs.put(prefix, JSON.stringify(sandbox.console), "json"),
      network: blobs.put(prefix, JSON.stringify(sandbox.network), "json"),
    };
    if (sandbox.blockedRequests.length) artifacts.blocked = blobs.put(prefix, JSON.stringify([...new Set(sandbox.blockedRequests)]), "json");
    await sandbox.close();
    const fs = await import("node:fs");
    if (fs.existsSync(sandbox.tracePath)) artifacts.trace = blobs.put(prefix, fs.readFileSync(sandbox.tracePath), "zip");
    sandbox = null;

    // The cost cap is a budget decision, not a fault: no retry.
    if (end.status === "infra_error") return { error: end.detail, noRetry: end.detail === COST_CAP_DETAIL };
    db.updateSession(sessionId, { status: end.status, outcome: end.status, outcomeDetail: end.detail, endedAt: Date.now(), artifacts });
    bus.publish(studyId, "session.status", { sessionId, status: end.status, detail: end.detail });
    return "ok";
  } catch (e) {
    const err = e as Error;
    const message = err instanceof InfraError || err instanceof FatalError ? err.message : `${err.name}: ${err.message.split("\n")[0]}`;
    return { error: message, fatal: err instanceof FatalError };
  } finally {
    await sandbox?.close().catch(() => {});
  }
}

async function runScriptSteps(sandbox: Sandbox, steps: NonNullable<TaskSpec["setup"]>): Promise<void> {
  const page = sandbox.page;
  for (const step of steps) {
    if (step.goto) await gotoWithBackoff(page, step.goto);
    if (step.fill) {
      const value = step.fill.secret ? process.env[step.fill.secret] : step.fill.value;
      if (value === undefined) throw new InfraError(`setup value for ${step.fill.selector} is missing (secret ${step.fill.secret ?? "?"} not set)`);
      await page.fill(step.fill.selector, value);
    }
    if (step.click) await page.click(step.click, { timeout: 10_000 });
    if (step.wait_for_url) await page.waitForURL(new RegExp(step.wait_for_url), { timeout: 15_000 });
    if (step.wait_ms) await page.waitForTimeout(step.wait_ms);
  }
}
