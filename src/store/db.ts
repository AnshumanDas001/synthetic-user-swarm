// Evidence store metadata: the spec's nine entities in SQLite (node:sqlite, no native deps).
// Blobs live in the content-addressed BlobStore; rows only hold their keys.
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import type {
  CandidateIssue, Issue, PersonaCard, SessionStatus, SignalRecord, StepRecord, StudySpec, TaskSpec,
} from "../types.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS study (
  id TEXT PRIMARY KEY, name TEXT, target_url TEXT, allowed_domains TEXT, persona_mix TEXT,
  budget TEXT, spec TEXT, status TEXT, build_id TEXT, cost_usd REAL DEFAULT 0,
  created_at INTEGER, finished_at INTEGER
);
CREATE TABLE IF NOT EXISTS task (
  id TEXT, study_id TEXT, goal_text TEXT, start_url TEXT, success_criteria TEXT,
  PRIMARY KEY (study_id, id)
);
CREATE TABLE IF NOT EXISTS persona (
  id TEXT, study_id TEXT, card TEXT, perception_profile TEXT, action_profile TEXT, budget TEXT,
  PRIMARY KEY (study_id, id)
);
CREATE TABLE IF NOT EXISTS session (
  id TEXT PRIMARY KEY, study_id TEXT, task_id TEXT, persona_id TEXT, repetition INTEGER, seed INTEGER,
  status TEXT, outcome TEXT, outcome_detail TEXT, step_count INTEGER DEFAULT 0, cost REAL DEFAULT 0,
  tokens INTEGER DEFAULT 0, est_human_ms INTEGER DEFAULT 0, attempts INTEGER DEFAULT 0,
  artifacts TEXT DEFAULT '{}', started_at INTEGER, ended_at INTEGER
);
CREATE INDEX IF NOT EXISTS session_study ON session(study_id);
CREATE TABLE IF NOT EXISTS step (
  id TEXT PRIMARY KEY, session_id TEXT, idx INTEGER, url TEXT, page_path TEXT, title TEXT, state_hash TEXT,
  action TEXT, think_aloud TEXT, expectation TEXT, confidence INTEGER, frustration INTEGER,
  target TEXT, observation TEXT, artifacts TEXT, tokens_in INTEGER, tokens_out INTEGER, cost REAL,
  model TEXT, est_human_ms INTEGER, started_at INTEGER, ended_at INTEGER
);
CREATE INDEX IF NOT EXISTS step_session ON step(session_id, idx);
CREATE TABLE IF NOT EXISTS signal (
  id TEXT PRIMARY KEY, step_id TEXT, session_id TEXT, type TEXT, details TEXT
);
CREATE INDEX IF NOT EXISTS signal_session ON signal(session_id);
CREATE TABLE IF NOT EXISTS candidate_issue (
  id TEXT PRIMARY KEY, session_id TEXT, study_id TEXT, data TEXT, embedding TEXT
);
CREATE TABLE IF NOT EXISTS issue (
  id TEXT PRIMARY KEY, study_id TEXT, severity REAL, data TEXT
);
CREATE TABLE IF NOT EXISTS report (
  id TEXT PRIMARY KEY, study_id TEXT, version INTEGER, compared_to_study_id TEXT, html_key TEXT, json_key TEXT,
  created_at INTEGER
);
CREATE TABLE IF NOT EXISTS page_audit (
  study_id TEXT, page_path TEXT, session_id TEXT, step_id TEXT, violations TEXT,
  PRIMARY KEY (study_id, page_path, session_id)
);
CREATE TABLE IF NOT EXISTS event (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, study_id TEXT, type TEXT, data TEXT, at INTEGER
);
CREATE INDEX IF NOT EXISTS event_study ON event(study_id, seq);
`;

export interface SessionRow {
  id: string; studyId: string; taskId: string; personaId: string; repetition: number; seed: number;
  status: SessionStatus; outcome: string | null; outcomeDetail: string | null; stepCount: number;
  cost: number; tokens: number; estHumanMs: number; attempts: number; artifacts: Record<string, string>;
  startedAt: number | null; endedAt: number | null;
}

export interface StudyRow {
  id: string; name: string; targetUrl: string; spec: StudySpec; status: string; buildId: string | null;
  costUsd: number; createdAt: number; finishedAt: number | null; ownerId: string | null; keySource: "platform" | "user";
}

const j = (v: unknown) => JSON.stringify(v ?? null);
const p = <T>(v: unknown): T => (v == null ? (null as T) : (JSON.parse(String(v)) as T));

export class Db {
  readonly sql: DatabaseSync;

  constructor(file = path.join(config.dataDir, "swarm.db")) {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    this.sql = new DatabaseSync(file);
    this.sql.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.sql.exec(SCHEMA);
    // Migration: study lease columns (one runner per study, across processes).
    const cols = (this.sql.prepare(`PRAGMA table_info(study)`).all() as { name: string }[]).map((c) => c.name);
    if (!cols.includes("runner")) this.sql.exec(`ALTER TABLE study ADD COLUMN runner TEXT; ALTER TABLE study ADD COLUMN lease_until INTEGER DEFAULT 0;`);
    // Migration: who owns a study and whose API key pays for it ("platform" or "user").
    if (!cols.includes("owner_id")) this.sql.exec(`ALTER TABLE study ADD COLUMN owner_id TEXT; ALTER TABLE study ADD COLUMN key_source TEXT DEFAULT 'platform';`);
  }

  // ---------------- study / task / persona

  insertStudy(id: string, spec: StudySpec, owner: { ownerId?: string | null; keySource?: "platform" | "user" } = {}): void {
    this.sql.prepare(
      `INSERT INTO study (id, name, target_url, allowed_domains, persona_mix, budget, spec, status, build_id, created_at, owner_id, key_source)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'planned', ?, ?, ?, ?)`,
    ).run(id, spec.name, spec.target_url, j(spec.allowed_domains), j(spec.personas), j(spec.budget), j(spec), spec.build_id ?? null, Date.now(), owner.ownerId ?? null, owner.keySource ?? "platform");
    const ins = this.sql.prepare(`INSERT INTO task (id, study_id, goal_text, start_url, success_criteria) VALUES (?, ?, ?, ?, ?)`);
    for (const t of spec.tasks) ins.run(t.id, id, t.goal, t.start_url ?? spec.target_url, j(t));
  }

  study(id: string): StudyRow | null {
    const r = this.sql.prepare(`SELECT * FROM study WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    return r ? this.mapStudy(r) : null;
  }

  studies(): StudyRow[] {
    return (this.sql.prepare(`SELECT * FROM study ORDER BY created_at DESC`).all() as Record<string, unknown>[]).map((r) => this.mapStudy(r));
  }

  private mapStudy(r: Record<string, unknown>): StudyRow {
    return {
      id: String(r.id), name: String(r.name), targetUrl: String(r.target_url), spec: p<StudySpec>(r.spec),
      status: String(r.status), buildId: (r.build_id as string) ?? null, costUsd: Number(r.cost_usd ?? 0),
      createdAt: Number(r.created_at), finishedAt: (r.finished_at as number) ?? null,
      ownerId: (r.owner_id as string) ?? null, keySource: (r.key_source as "platform" | "user") ?? "platform",
    };
  }

  setStudyStatus(id: string, status: string): void {
    this.sql.prepare(`UPDATE study SET status = ?, finished_at = CASE WHEN ? IN ('complete','stopped') THEN ? ELSE finished_at END WHERE id = ?`)
      .run(status, status, Date.now(), id);
  }

  // Take (or renew) the study's lease. Succeeds only if nobody else holds a live lease.
  acquireStudyLease(id: string, runner: string, ttlMs: number): boolean {
    const now = Date.now();
    const r = this.sql.prepare(`UPDATE study SET runner = ?, lease_until = ? WHERE id = ? AND (runner IS NULL OR runner = ? OR lease_until < ?)`)
      .run(runner, now + ttlMs, id, runner, now);
    return Number(r.changes) === 1;
  }

  releaseStudyLease(id: string, runner: string): void {
    this.sql.prepare(`UPDATE study SET runner = NULL, lease_until = 0 WHERE id = ? AND runner = ?`).run(id, runner);
  }

  studyLease(id: string): { runner: string | null; leaseUntil: number } {
    const r = this.sql.prepare(`SELECT runner, lease_until FROM study WHERE id = ?`).get(id) as { runner: string | null; lease_until: number } | undefined;
    return { runner: r?.runner ?? null, leaseUntil: Number(r?.lease_until ?? 0) };
  }

  // Atomically move a session from queued to provisioning; false if another worker got it first.
  claimSession(id: string): boolean {
    const r = this.sql.prepare(`UPDATE session SET status = 'provisioning' WHERE id = ? AND status = 'queued'`).run(id);
    return Number(r.changes) === 1;
  }

  addStudyCost(id: string, usd: number): number {
    this.sql.prepare(`UPDATE study SET cost_usd = cost_usd + ? WHERE id = ?`).run(usd, id);
    return Number((this.sql.prepare(`SELECT cost_usd FROM study WHERE id = ?`).get(id) as { cost_usd: number }).cost_usd);
  }

  tasks(studyId: string): TaskSpec[] {
    return (this.sql.prepare(`SELECT success_criteria FROM task WHERE study_id = ? ORDER BY rowid`).all(studyId) as { success_criteria: string }[])
      .map((r) => p<TaskSpec>(r.success_criteria));
  }

  insertPersona(studyId: string, card: PersonaCard, perception: unknown, action: unknown, budget: unknown): void {
    this.sql.prepare(
      `INSERT OR REPLACE INTO persona (id, study_id, card, perception_profile, action_profile, budget) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(card.id, studyId, j(card), j(perception), j(action), j(budget));
  }

  personas(studyId: string): PersonaCard[] {
    return (this.sql.prepare(`SELECT card FROM persona WHERE study_id = ? ORDER BY rowid`).all(studyId) as { card: string }[])
      .map((r) => p<PersonaCard>(r.card));
  }

  // ---------------- session

  insertSession(s: Pick<SessionRow, "id" | "studyId" | "taskId" | "personaId" | "repetition" | "seed">): void {
    this.sql.prepare(
      `INSERT INTO session (id, study_id, task_id, persona_id, repetition, seed, status) VALUES (?, ?, ?, ?, ?, ?, 'queued')`,
    ).run(s.id, s.studyId, s.taskId, s.personaId, s.repetition, s.seed);
  }

  updateSession(id: string, patch: Partial<SessionRow>): void {
    const cols: Record<string, string> = {
      status: "status", outcome: "outcome", outcomeDetail: "outcome_detail", stepCount: "step_count", cost: "cost",
      tokens: "tokens", estHumanMs: "est_human_ms", attempts: "attempts", artifacts: "artifacts",
      startedAt: "started_at", endedAt: "ended_at",
    };
    const sets: string[] = [];
    const vals: (string | number | null)[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (!(k in cols)) continue;
      sets.push(`${cols[k]} = ?`);
      vals.push(k === "artifacts" ? j(v) : (v as string | number | null));
    }
    if (!sets.length) return;
    this.sql.prepare(`UPDATE session SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
  }

  session(id: string): SessionRow | null {
    const r = this.sql.prepare(`SELECT * FROM session WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    return r ? this.mapSession(r) : null;
  }

  sessions(studyId: string): SessionRow[] {
    return (this.sql.prepare(`SELECT * FROM session WHERE study_id = ? ORDER BY rowid`).all(studyId) as Record<string, unknown>[])
      .map((r) => this.mapSession(r));
  }

  private mapSession(r: Record<string, unknown>): SessionRow {
    return {
      id: String(r.id), studyId: String(r.study_id), taskId: String(r.task_id), personaId: String(r.persona_id),
      repetition: Number(r.repetition), seed: Number(r.seed), status: r.status as SessionStatus,
      outcome: (r.outcome as string) ?? null, outcomeDetail: (r.outcome_detail as string) ?? null,
      stepCount: Number(r.step_count ?? 0), cost: Number(r.cost ?? 0), tokens: Number(r.tokens ?? 0),
      estHumanMs: Number(r.est_human_ms ?? 0), attempts: Number(r.attempts ?? 0),
      artifacts: p<Record<string, string>>(r.artifacts) ?? {},
      startedAt: (r.started_at as number) ?? null, endedAt: (r.ended_at as number) ?? null,
    };
  }

  // ---------------- step / signal

  insertStep(s: StepRecord): void {
    this.sql.prepare(
      `INSERT INTO step (id, session_id, idx, url, page_path, title, state_hash, action, think_aloud, expectation, confidence,
        frustration, target, observation, artifacts, tokens_in, tokens_out, cost, model, est_human_ms, started_at, ended_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      s.id, s.sessionId, s.idx, s.url, s.pagePath, s.title, s.stateHash, j(s.action), s.thinkAloud, j(s.expectation),
      s.confidence, s.frustration, j(s.target ?? null), j(s.observation), j(s.artifacts), s.tokensIn, s.tokensOut,
      s.costUsd, s.model, s.estHumanMs, s.startedAt, s.endedAt,
    );
  }

  steps(sessionId: string): StepRecord[] {
    return (this.sql.prepare(`SELECT * FROM step WHERE session_id = ? ORDER BY idx`).all(sessionId) as Record<string, unknown>[])
      .map((r) => this.mapStep(r));
  }

  step(id: string): StepRecord | null {
    const r = this.sql.prepare(`SELECT * FROM step WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    return r ? this.mapStep(r) : null;
  }

  stepsByIds(ids: string[]): StepRecord[] {
    if (!ids.length) return [];
    const q = `SELECT * FROM step WHERE id IN (${ids.map(() => "?").join(",")})`;
    return (this.sql.prepare(q).all(...ids) as Record<string, unknown>[]).map((r) => this.mapStep(r));
  }

  private mapStep(r: Record<string, unknown>): StepRecord {
    return {
      id: String(r.id), sessionId: String(r.session_id), idx: Number(r.idx), url: String(r.url), pagePath: String(r.page_path),
      title: String(r.title ?? ""), stateHash: String(r.state_hash), action: p(r.action), thinkAloud: String(r.think_aloud ?? ""),
      expectation: p(r.expectation), confidence: Number(r.confidence), frustration: Number(r.frustration), target: p(r.target),
      observation: p(r.observation), artifacts: p(r.artifacts) ?? {}, tokensIn: Number(r.tokens_in), tokensOut: Number(r.tokens_out),
      costUsd: Number(r.cost), model: String(r.model), estHumanMs: Number(r.est_human_ms), startedAt: Number(r.started_at),
      endedAt: Number(r.ended_at),
    };
  }

  replaceSignals(sessionId: string, signals: SignalRecord[]): void {
    this.sql.prepare(`DELETE FROM signal WHERE session_id = ?`).run(sessionId);
    const ins = this.sql.prepare(`INSERT INTO signal (id, step_id, session_id, type, details) VALUES (?, ?, ?, ?, ?)`);
    for (const s of signals) ins.run(s.id, s.stepId, s.sessionId, s.type, j(s.details));
  }

  signals(sessionId: string): SignalRecord[] {
    return (this.sql.prepare(`SELECT * FROM signal WHERE session_id = ?`).all(sessionId) as Record<string, unknown>[]).map((r) => ({
      id: String(r.id), stepId: String(r.step_id), sessionId: String(r.session_id), type: r.type as SignalRecord["type"], details: p(r.details),
    }));
  }

  // ---------------- candidates / issues

  replaceCandidates(sessionId: string, studyId: string, cands: CandidateIssue[]): void {
    this.sql.prepare(`DELETE FROM candidate_issue WHERE session_id = ?`).run(sessionId);
    const ins = this.sql.prepare(`INSERT INTO candidate_issue (id, session_id, study_id, data, embedding) VALUES (?, ?, ?, ?, ?)`);
    for (const c of cands) {
      const { embedding, ...rest } = c;
      ins.run(c.id, sessionId, studyId, j(rest), j(embedding));
    }
  }

  candidates(studyId: string): CandidateIssue[] {
    return (this.sql.prepare(`SELECT data, embedding FROM candidate_issue WHERE study_id = ?`).all(studyId) as { data: string; embedding: string }[])
      .map((r) => ({ ...p<CandidateIssue>(r.data), embedding: p<number[]>(r.embedding) }));
  }

  replaceIssues(studyId: string, issues: Issue[]): void {
    this.sql.prepare(`DELETE FROM issue WHERE study_id = ?`).run(studyId);
    const ins = this.sql.prepare(`INSERT INTO issue (id, study_id, severity, data) VALUES (?, ?, ?, ?)`);
    for (const i of issues) ins.run(i.id, studyId, i.severity, j(i));
  }

  issues(studyId: string): Issue[] {
    return (this.sql.prepare(`SELECT data FROM issue WHERE study_id = ? ORDER BY severity DESC`).all(studyId) as { data: string }[])
      .map((r) => p<Issue>(r.data));
  }

  // ---------------- audits / reports / events

  upsertAudit(studyId: string, pagePath: string, sessionId: string, stepId: string, violations: unknown): void {
    this.sql.prepare(`INSERT OR REPLACE INTO page_audit (study_id, page_path, session_id, step_id, violations) VALUES (?, ?, ?, ?, ?)`)
      .run(studyId, pagePath, sessionId, stepId, j(violations));
  }

  audits(studyId: string): { pagePath: string; sessionId: string; stepId: string; violations: AxeViolation[] }[] {
    return (this.sql.prepare(`SELECT * FROM page_audit WHERE study_id = ?`).all(studyId) as Record<string, unknown>[]).map((r) => ({
      pagePath: String(r.page_path), sessionId: String(r.session_id), stepId: String(r.step_id), violations: p<AxeViolation[]>(r.violations) ?? [],
    }));
  }

  insertReport(r: { id: string; studyId: string; version: number; comparedTo: string | null; htmlKey: string; jsonKey: string }): void {
    this.sql.prepare(`INSERT INTO report (id, study_id, version, compared_to_study_id, html_key, json_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(r.id, r.studyId, r.version, r.comparedTo, r.htmlKey, r.jsonKey, Date.now());
  }

  latestReportVersion(studyId: string): number {
    const r = this.sql.prepare(`SELECT MAX(version) v FROM report WHERE study_id = ?`).get(studyId) as { v: number | null };
    return r.v ?? 0;
  }

  lastEventSeq(studyId: string): number {
    const r = this.sql.prepare(`SELECT MAX(seq) s FROM event WHERE study_id = ?`).get(studyId) as { s: number | null };
    return r.s ?? 0;
  }

  // Latest step per session, for the live wall's first paint.
  lastSteps(studyId: string): StepRecord[] {
    const rows = this.sql.prepare(
      `SELECT st.* FROM step st JOIN (SELECT session_id, MAX(idx) m FROM step WHERE session_id IN (SELECT id FROM session WHERE study_id = ?) GROUP BY session_id) last
       ON st.session_id = last.session_id AND st.idx = last.m`,
    ).all(studyId) as Record<string, unknown>[];
    return rows.map((r) => this.mapStep(r));
  }

  appendEvent(studyId: string, type: string, data: unknown): number {
    const r = this.sql.prepare(`INSERT INTO event (study_id, type, data, at) VALUES (?, ?, ?, ?)`).run(studyId, type, j(data), Date.now());
    return Number(r.lastInsertRowid);
  }

  events(studyId: string, afterSeq = 0): { seq: number; type: string; data: unknown; at: number }[] {
    return (this.sql.prepare(`SELECT * FROM event WHERE study_id = ? AND seq > ? ORDER BY seq`).all(studyId, afterSeq) as Record<string, unknown>[])
      .map((r) => ({ seq: Number(r.seq), type: String(r.type), data: p(r.data), at: Number(r.at) }));
  }
}

export interface AxeViolation {
  id: string;
  impact: string | null;
  help: string;
  helpUrl: string;
  nodes: { target: string[]; html: string }[];
}
