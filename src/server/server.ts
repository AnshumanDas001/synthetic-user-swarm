// API + live dashboard server. The dashboard and the report read the same evidence store, so what the
// audience sees live is exactly what the report cites. Events stream over Server-Sent Events.
// In hosted mode (Google sign-in) every study belongs to a user: people see only their own work, get one
// free run on the platform's key, and can then run on their own OpenRouter key.
import express, { type NextFunction, type Request, type Response } from "express";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import YAML from "yaml";
import { config, multiUser } from "../config.js";
import { createDeps, planStudy, runStudy, StudyBusyError } from "../orchestrator/orchestrator.js";
import { buildReport } from "../report/html.js";
import { diffStudies } from "../report/diff.js";
import { exportIssue } from "../report/integrations.js";
import { loadCuratedPersonas } from "../personas/library.js";
import { isMobile } from "../personas/profiles.js";
import { log } from "../util/common.js";
import { creditsRemaining, LlmHttpError, withApiKey } from "../llm/client.js";
import { estimateStudy } from "../llm/estimate.js";
import { discoverDomains } from "../runtime/domains.js";
import { assertUrlSafe } from "../runtime/netguard.js";
import { buildReportData } from "../report/data.js";
import { StudySpec } from "../types.js";
import { authEnabled, authMode, currentUser, installAuth } from "./auth.js";
import { createAccountStore, today, type User } from "../store/accounts.js";
import { decrypt, encrypt } from "../util/secrets.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) {
    super(message);
  }
}

export async function startServer(port = config.port) {
  const deps = createDeps();
  const { db, bus, blobs } = deps;
  const accounts = createAccountStore();
  await accounts.init();
  if (config.demoShop) {
    // The bundled demo shop, so hosted users have a safe site to try the swarm on.
    const { startShop } = await import("../../demo-shop/server.js");
    startShop(config.demoShopPort);
  }
  const running = new Map<string, AbortController>();
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "2mb" }));
  app.use(express.text({ type: ["text/yaml", "application/yaml", "text/plain"], limit: "2mb" }));
  app.set("trust proxy", multiUser() ? 1 : "loopback");
  app.get("/healthz", (_req, res) => res.json({ ok: true }));
  installAuth(app, accounts);

  const isAdmin = (u: User) => u.role === "admin";
  const canSee = (u: User, studyId: string) => {
    const s = db.study(studyId);
    return !!s && (isAdmin(u) || s.ownerId === u.id);
  };
  const visibleStudies = (u: User) => db.studies().filter((s) => isAdmin(u) || s.ownerId === u.id);
  const freeLeft = (u: User) => (isAdmin(u) ? Infinity : Math.max(0, config.limits.freeRuns - u.freeRunsUsed));

  // Every route that names a study (API, evidence, reports, replays) checks the caller may see it.
  const guard = (req: Request, res: Response, next: NextFunction) => {
    const id = (req.params as Record<string, string>)[0] ?? (req.params as Record<string, string>).id;
    if (!id || !canSee(currentUser(req), id)) return res.status(404).json({ error: "not found" });
    next();
  };
  app.use(/^\/api\/studies\/(study_[a-f0-9]+)/, guard);
  app.use(/^\/reports\/(study_[a-f0-9]+)/, guard);
  app.use(/^\/replay\/(study_[a-f0-9]+)/, guard);
  app.use(/^\/blobs\/(study_[a-f0-9]+)/, guard);

  const wrap = (fn: (req: Request, res: Response) => Promise<unknown> | unknown) => async (req: Request, res: Response) => {
    try {
      await fn(req, res);
    } catch (e) {
      const err = e as HttpError;
      res.status(err.status ?? 400).json({ error: err.message, code: err.code });
    }
  };

  // ---------------- account
  app.get("/api/me", wrap(async (req, res) => {
    const u = currentUser(req);
    res.json({
      mode: authMode(), auth: authEnabled(),
      user: { id: u.id, name: u.name, email: u.email, picture: u.picture, role: u.role },
      freeRunsLeft: freeLeft(u) === Infinity ? null : freeLeft(u), freeRuns: config.limits.freeRuns,
      hasKey: !!u.apiKeyEnc, keyLast4: u.apiKeyLast4,
      limits: { free: { sessions: config.limits.freeMaxSessions, steps: config.limits.freeMaxSteps, costUsd: config.limits.freeCostCapUsd }, ownKeySessions: config.limits.userMaxSessions },
    });
  }));

  // Bring your own key: validated against OpenRouter, encrypted at rest, never sent back to the browser.
  app.post("/api/account/key", wrap(async (req, res) => {
    const u = currentUser(req);
    if (!multiUser()) throw new HttpError(400, "Personal keys are for the hosted service; locally, set OPENROUTER_API_KEY in .env.");
    const key = String(req.body?.key ?? "").trim();
    if (!/^sk-or-[\w-]{20,}$/.test(key)) throw new HttpError(400, "That doesn't look like an OpenRouter key (it starts with sk-or-).");
    let credit;
    try {
      credit = await withApiKey(key, () => creditsRemaining());
    } catch (e) {
      throw new HttpError(400, e instanceof LlmHttpError ? "OpenRouter rejected this key." : `Could not check the key: ${(e as Error).message}`);
    }
    await accounts.setApiKey(u.id, encrypt(key), key.slice(-4));
    res.json({ ok: true, last4: key.slice(-4), remainingUsd: credit.remainingUsd });
  }));
  app.delete("/api/account/key", wrap(async (req, res) => {
    await accounts.setApiKey(currentUser(req).id, null, null);
    res.json({ ok: true });
  }));

  // Credit shown in the sidebar: the platform's to admins, your own key's to everyone else.
  app.get("/api/credits", wrap(async (req, res) => {
    const u = currentUser(req);
    if (config.modelMode !== "live") return res.json({ mode: config.modelMode, remainingUsd: null });
    if (!isAdmin(u)) {
      if (!u.apiKeyEnc) return res.json({ mode: config.modelMode, scope: "none", remainingUsd: null, freeRunsLeft: freeLeft(u) });
      const c = await withApiKey(decrypt(u.apiKeyEnc), () => creditsRemaining()).catch(() => null);
      return res.json({ mode: config.modelMode, scope: "own", ...(c ?? { remainingUsd: null }), reserveUsd: 0 });
    }
    res.json({ mode: config.modelMode, scope: "platform", ...(await creditsRemaining()), reserveUsd: config.creditReserveUsd });
  }));

  app.get("/api/config", wrap((req, res) => {
    const u = currentUser(req);
    res.json({
      mode: config.modelMode, models: config.models, effort: config.effort, reserveUsd: config.creditReserveUsd,
      imageMaxWidth: config.modelImageMaxWidth, perDomainConcurrency: config.perDomainConcurrency,
      auth: authEnabled(), authMode: authMode(), admin: isAdmin(u), limits: config.limits, demoShop: config.demoShop, demoShopPort: config.demoShopPort,
      ...(isAdmin(u) ? {
        dataDir: config.dataDir, host: process.env.SWARM_HOST ?? "127.0.0.1", accountsStore: config.databaseUrl ? "postgres" : "sqlite",
        integrations: {
          github: !!(process.env.GITHUB_TOKEN && process.env.GITHUB_REPO),
          jira: !!(process.env.JIRA_BASE_URL && process.env.JIRA_EMAIL && process.env.JIRA_API_TOKEN && process.env.JIRA_PROJECT_KEY),
          linear: !!(process.env.LINEAR_API_KEY && process.env.LINEAR_TEAM_ID),
        },
      } : {}),
    });
  }));

  // ---------------- studies
  app.get("/api/studies", wrap((req, res) => res.json(visibleStudies(currentUser(req)).map((s) => studySummary(s.id)))));

  // One row per study for the overview: progress, outcomes, issue counts by severity, cost.
  function studySummary(id: string) {
    const s = db.study(id)!;
    const sessions = db.sessions(id);
    const outcome = (x: (typeof sessions)[number]) => x.outcome ?? x.status;
    const finished = sessions.filter((x) => !["queued", "provisioning", "running"].includes(x.status));
    const analysable = finished.filter((x) => outcome(x) !== "infra_error");
    const issues = db.issues(id);
    const sev = (lo: number, hi: number) => issues.filter((i) => i.severity >= lo && i.severity < hi).length;
    return {
      id: s.id, name: s.name, status: s.status, costUsd: s.costUsd, capUsd: s.spec.budget.cost_cap_usd, createdAt: s.createdAt,
      finishedAt: s.finishedAt, targetUrl: s.targetUrl, running: running.has(s.id) || s.status === "running", keySource: s.keySource,
      tasks: s.spec.tasks.map((t) => t.id), personas: db.personas(id).length, repetitions: s.spec.budget.repetitions,
      sessions: sessions.length, finished: finished.length,
      succeeded: analysable.filter((x) => outcome(x) === "succeeded").length, analysable: analysable.length,
      issues: issues.length, severity: { critical: sev(3.5, 9), major: sev(2.5, 3.5), minor: sev(1.5, 2.5), cosmetic: sev(0, 1.5) },
    };
  }

  // Command palette search across the caller's studies and issues.
  app.get("/api/search", wrap((req, res) => {
    const q = String(req.query.q ?? "").toLowerCase().trim();
    const out: { kind: string; title: string; sub: string; href: string }[] = [];
    for (const st of visibleStudies(currentUser(req))) {
      if (!q || st.name.toLowerCase().includes(q) || st.targetUrl.toLowerCase().includes(q)) out.push({ kind: "study", title: st.name, sub: st.targetUrl, href: `#/study/${st.id}` });
      if (q.length >= 2) for (const i of db.issues(st.id)) {
        if (`${i.title} ${i.page} ${i.element}`.toLowerCase().includes(q)) out.push({ kind: "issue", title: i.title, sub: `${st.name} · ${i.page}`, href: `#/study/${st.id}/issues/${i.id}` });
      }
    }
    res.json(out.slice(0, 30));
  }));

  app.post("/api/estimate", wrap(async (req, res) => {
    const spec = StudySpec.parse(req.body);
    const count = spec.personas.size ?? (spec.personas.include.length || loadCuratedPersonas().length);
    res.json(await estimateStudy(spec, count));
  }));

  const discovering = new Map<string, number>();
  app.post("/api/domains", wrap(async (req, res) => {
    const u = currentUser(req);
    const url = String(req.body?.url ?? "");
    if (!/^https?:\/\//.test(url)) throw new HttpError(400, "Enter a full URL starting with http:// or https://");
    await assertUrlSafe(url, "The site URL");
    if ((discovering.get(u.id) ?? 0) > Date.now()) throw new HttpError(429, "One domain check at a time; try again in a few seconds.");
    discovering.set(u.id, Date.now() + 30_000);
    try {
      res.json(await discoverDomains(url));
    } finally {
      discovering.delete(u.id);
    }
  }));

  // ---------------- launch policy
  // Admins (and local/password mode) use the platform key without limits. Everyone else gets
  // config.limits.freeRuns small runs on the platform key, then runs on their own key.
  let reservedFreeUsd = 0;
  app.post("/api/studies", wrap(async (req, res) => {
    const u = currentUser(req);
    const body = typeof req.body === "string" ? YAML.parse(req.body) : req.body;
    const { useOwnKey, ...raw } = body ?? {};
    const spec = StudySpec.parse(raw);
    const L = config.limits;
    if (running.size >= L.maxActiveStudies && !isAdmin(u)) {
      throw new HttpError(429, `The swarm is busy with ${running.size} other ${running.size === 1 ? "study" : "studies"}. Try again in a few minutes.`, "busy");
    }
    const personaCount = spec.personas.include.length || loadCuratedPersonas().length;
    const sessions = (personaCount + spec.personas.generate.reduce((a, g) => a + g.count, 0)) * spec.tasks.length * spec.budget.repetitions;

    let keySource: "platform" | "user" = "platform";
    let freeRun = false;
    if (multiUser() && !isAdmin(u)) {
      if (useOwnKey || freeLeft(u) === 0) {
        if (!u.apiKeyEnc) throw new HttpError(402, `You've used your free run. Add your OpenRouter API key in Settings to keep going.`, "needs_key");
        keySource = "user";
        if (sessions > L.userMaxSessions) throw new HttpError(400, `Runs are limited to ${L.userMaxSessions} sessions (personas × tasks × repetitions); this one has ${sessions}.`);
        spec.budget.concurrency = Math.min(spec.budget.concurrency, 3);
      } else {
        if (spec.personas.generate.length) throw new HttpError(400, "Generated personas need your own API key; pick curated personas for the free run.");
        if (sessions > L.freeMaxSessions) throw new HttpError(400, `The free run allows up to ${L.freeMaxSessions} sessions (for example ${L.freeMaxSessions} personas × 1 task × 1 repetition); this one has ${sessions}.`, "free_limit");
        const spent = await accounts.platformSpend(today());
        if (spent + reservedFreeUsd + L.freeCostCapUsd > L.platformDailyCapUsd) {
          throw new HttpError(429, "Today's free capacity is used up. Add your own OpenRouter key in Settings, or try again tomorrow.", "daily_cap");
        }
        spec.budget.cost_cap_usd = Math.min(spec.budget.cost_cap_usd, L.freeCostCapUsd);
        spec.budget.max_steps = Math.min(spec.budget.max_steps ?? L.freeMaxSteps, L.freeMaxSteps);
        spec.budget.concurrency = Math.min(spec.budget.concurrency, 2);
        if (!(await accounts.consumeFreeRun(u.id, L.freeRuns))) throw new HttpError(402, "You've used your free run. Add your OpenRouter API key in Settings to keep going.", "needs_key");
        freeRun = true;
      }
    }
    let id: string;
    try {
      id = await planStudy(deps, spec, { ownerId: u.id, keySource });
    } catch (e) {
      if (freeRun) await accounts.refundFreeRun(u.id);
      throw e;
    }
    startRun(id, { freeRun });
    res.status(201).json({ id, keySource });
  }));

  app.post("/api/studies/:id/resume", wrap((req, res) => {
    startRun(String(req.params.id));
    res.json({ ok: true });
  }));
  app.post("/api/studies/:id/stop", wrap((req, res) => {
    running.get(String(req.params.id))?.abort();
    res.json({ ok: true });
  }));

  // Runs a study on the right key. Free runs reserve their cap against the daily platform budget and
  // record what they actually spent; a free run that never started is refunded.
  async function keyFor(studyId: string): Promise<string | null> {
    const s = db.study(studyId)!;
    if (s.keySource !== "user") return null;
    const owner = s.ownerId ? await accounts.getUser(s.ownerId) : null;
    if (!owner?.apiKeyEnc) throw new Error("This study runs on your own OpenRouter key, which has been removed. Add it again in Settings, then resume.");
    return decrypt(owner.apiKeyEnc);
  }

  function startRun(id: string, opts: { freeRun?: boolean } = {}) {
    if (running.has(id)) return;
    const ac = new AbortController();
    running.set(id, ac);
    const study = db.study(id)!;
    const platformFree = study.keySource === "platform" && multiUser() && study.ownerId && study.ownerId !== "admin";
    if (platformFree) reservedFreeUsd += study.spec.budget.cost_cap_usd;
    (async () => {
      const key = await keyFor(id);
      await withApiKey(key, () => runStudy(deps, id, { signal: ac.signal, llmMerge: true }));
      await buildReport(deps, id);
    })()
      .catch(async (e) => {
        if (e instanceof StudyBusyError) return;
        log("server", `study ${id} failed: ${(e as Error).message}`);
        bus.publish(id, "log", { level: "error", message: (e as Error).message });
        db.setStudyStatus(id, "stopped");
        if (opts.freeRun && (db.study(id)?.costUsd ?? 0) === 0 && study.ownerId) await accounts.refundFreeRun(study.ownerId).catch(() => {});
      })
      .finally(async () => {
        running.delete(id);
        if (platformFree) {
          reservedFreeUsd = Math.max(0, reservedFreeUsd - study.spec.budget.cost_cap_usd);
          await accounts.addPlatformSpend(today(), db.study(id)?.costUsd ?? 0).catch(() => {});
        }
      });
  }

  app.get("/api/studies/:id/report-data", wrap((req, res) => {
    const d = buildReportData(db, String(req.params.id));
    const latest = db.latestReportVersion(String(req.params.id));
    res.json({ ...d, reportUrl: latest ? `/reports/${String(req.params.id)}/v${latest}/index.html` : null });
  }));

  app.get("/api/studies/:id", (req, res) => {
    const study = db.study(req.params.id)!;
    const personas = db.personas(study.id);
    res.json({
      study, tasks: db.tasks(study.id),
      personas: personas.map((p) => ({ ...p, mobile: isMobile(p) })),
      sessions: db.sessions(study.id).map((s) => ({ ...s, personaName: personas.find((p) => p.id === s.personaId)?.name })),
      issues: db.issues(study.id),
      running: running.has(study.id) || study.status === "running",
      lastSeq: db.lastEventSeq(study.id),
      lastSteps: Object.fromEntries(db.lastSteps(study.id).map((st) => [st.sessionId, {
        idx: st.idx, pagePath: st.pagePath, thinkAloud: st.thinkAloud, frustration: st.frustration,
        shot: st.artifacts.before_marked ?? st.artifacts.before ?? null, clean: st.artifacts.before ?? null, action: st.action, target: st.target?.name ?? null,
      }])),
    });
  });

  // Live event stream: replay everything after ?after=seq, then follow.
  app.get("/api/studies/:id/events", (req, res) => {
    const studyId = req.params.id;
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" });
    const send = (ev: { seq: number; type: string; data: unknown; at: number }) => res.write(`id: ${ev.seq}\nevent: ${ev.type}\ndata: ${JSON.stringify({ ...ev })}\n\n`);
    let lastSeq = Number(req.query.after ?? req.headers["last-event-id"] ?? 0);
    const emit = (ev: { seq: number; type: string; data: unknown; at: number }) => {
      if (ev.seq <= lastSeq) return;
      lastSeq = ev.seq;
      send(ev);
    };
    for (const ev of bus.replay(studyId, lastSeq)) emit(ev);
    const off = bus.subscribe(studyId, emit);
    // Studies run by another process (the CLI) write the same events table: follow it too.
    const poll = setInterval(() => { for (const ev of bus.replay(studyId, lastSeq)) emit(ev); }, 1000);
    const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
    req.on("close", () => {
      off();
      clearInterval(poll);
      clearInterval(ping);
    });
  });

  app.get("/api/studies/:id/issues", (req, res) => res.json(db.issues(req.params.id)));
  const ownSession = (studyId: string, sid: string) => db.session(sid)?.studyId === studyId;
  app.get("/api/studies/:id/sessions/:sid/steps", (req, res) => (ownSession(req.params.id, req.params.sid) ? res.json(db.steps(req.params.sid)) : res.status(404).json({ error: "not found" })));
  app.get("/api/studies/:id/sessions/:sid/signals", (req, res) => (ownSession(req.params.id, req.params.sid) ? res.json(db.signals(req.params.sid)) : res.status(404).json({ error: "not found" })));
  app.get("/api/studies/:id/sessions/:sid/replay", (req, res) => {
    const s = db.session(req.params.sid);
    const key = s?.studyId === req.params.id ? s.artifacts.rrweb : undefined;
    if (!key || !blobs.exists(key)) return res.status(404).json({ error: "No replay recorded for this session yet." });
    res.type("json").sendFile(blobs.path(key));
  });
  app.get("/api/studies/:id/steps/:stepId", (req, res) => {
    const st = db.step(req.params.stepId);
    return st && ownSession(req.params.id, st.sessionId) ? res.json(st) : res.status(404).json({ error: "not found" });
  });
  app.get("/api/studies/:id/diff/:base", wrap((req, res) => {
    if (!canSee(currentUser(req), String(req.params.base))) throw new HttpError(404, "not found");
    res.json(diffStudies(db, String(req.params.base), String(req.params.id)));
  }));
  app.post("/api/studies/:id/report", wrap(async (req, res) => {
    const compareTo = req.body?.compareTo && canSee(currentUser(req), req.body.compareTo) ? req.body.compareTo : undefined;
    const id = String(req.params.id);
    const r = await buildReport(deps, id, { compareTo, pdf: !!req.body?.pdf });
    res.json({ url: `/reports/${id}/v${r.version}/index.html`, version: r.version });
  }));
  app.post("/api/issues/:id/export", wrap(async (req, res) => {
    const u = currentUser(req);
    const studyId = String(req.body?.studyId ?? "");
    if (!canSee(u, studyId)) throw new HttpError(404, "not found");
    // Only admins may file tickets with the server's integration credentials; others get the ready-made ticket.
    res.json(await exportIssue(deps, String(req.params.id), req.body?.to ?? "github", { studyId, dryRun: !!req.body?.dryRun || !isAdmin(u) }));
  }));
  app.get("/api/personas", (_req, res) => res.json(loadCuratedPersonas().map((p) => ({ ...p, mobile: isMobile(p) }))));
  app.get("/api/studies/:id/spec.yaml", (req, res) => res.type("text/yaml").send(YAML.stringify(db.study(req.params.id)!.spec)));

  // "Watch it happen": open the session replay at the step's timestamp.
  app.get("/replay/:studyId/step/:stepId", (req, res) => {
    const st = db.step(req.params.stepId);
    if (!st || !ownSession(req.params.studyId, st.sessionId)) return res.status(404).send("step not found");
    const key = db.session(st.sessionId)?.artifacts.rrweb;
    if (!key) return res.status(404).send("replay not recorded yet (session still running?)");
    const events = JSON.parse(blobs.get(key).toString()) as { timestamp: number }[];
    const t = Math.max(0, st.startedAt - (events[0]?.timestamp ?? st.startedAt) - 500);
    res.redirect(`/replay.html?src=${encodeURIComponent(`/blobs/${key}`)}&t=${t}`);
  });

  // ---------------- static
  app.get(/^\/blobs\/(.+)$/, (req, res) => {
    const key = (req.params as unknown as string[])[0];
    try {
      const file = blobs.path(key);
      if (!fs.existsSync(file)) return res.status(404).end();
      res.setHeader("cache-control", "private, max-age=31536000, immutable");
      res.sendFile(file);
    } catch {
      res.status(400).end();
    }
  });
  app.use("/reports", express.static(path.join(config.dataDir, "reports")));
  app.use("/player", express.static(path.dirname(require.resolve("rrweb-player/dist/index.js"))));
  app.use(express.static(path.join(here, "public")));

  // Without a login the dashboard must stay on this machine.
  const host = process.env.SWARM_HOST ?? "127.0.0.1";
  if (!["127.0.0.1", "localhost", "::1"].includes(host) && !authEnabled()) {
    throw new Error(`refusing to listen on ${host} without a login: set GOOGLE_CLIENT_ID (+ secret) or SWARM_PASSWORD`);
  }
  const server = app.listen(port, host, () => log("server", `dashboard on http://localhost:${port}  (bound to ${host}; auth: ${authMode()}; accounts: ${config.databaseUrl ? "postgres" : "sqlite"}; model mode: ${config.modelMode})`));
  // Pre-warm the browser pool so tiles light up the moment Launch is pressed.
  deps.pool.warm().catch((e) => log("server", `browser pre-warm failed: ${(e as Error).message}`));
  // Resume only studies whose runner died (lease expired); a study another process is running is left alone.
  for (const s of db.studies()) if (s.status === "running") {
    const lease = db.studyLease(s.id);
    if (lease.runner && lease.leaseUntil > Date.now()) {
      log("server", `study ${s.id} is being run by another process (${lease.runner}); following it live`);
      continue;
    }
    log("server", `resuming study ${s.id}`);
    startRun(s.id);
  }
  const shutdown = async () => {
    for (const ac of running.values()) ac.abort();
    server.close();
    await deps.pool.close();
    await accounts.close().catch(() => {});
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  return server;
}
