// Accounts: users, free-run usage, encrypted API keys and the platform's daily free-run spend.
// Kept separate from the evidence store so it can live in a durable Postgres (DATABASE_URL) while studies sit
// on an ephemeral disk (e.g. Render's free tier). Falls back to SQLite next to the evidence store.
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { config } from "../config.js";
import { newId } from "../util/common.js";

export interface User {
  id: string;
  sub: string;          // Google subject id (or "local"/"admin" for non-Google modes)
  email: string;
  name: string;
  picture: string | null;
  role: "admin" | "user";
  freeRunsUsed: number;
  apiKeyEnc: string | null;
  apiKeyLast4: string | null;
  createdAt: number;
}

export interface AccountStore {
  init(): Promise<void>;
  upsertGoogleUser(p: { sub: string; email: string; name: string; picture: string | null }): Promise<User>;
  getUser(id: string): Promise<User | null>;
  // Atomically take one free run; false when the user has none left.
  consumeFreeRun(userId: string, limit: number): Promise<boolean>;
  refundFreeRun(userId: string): Promise<void>;
  setApiKey(userId: string, enc: string | null, last4: string | null): Promise<void>;
  addPlatformSpend(day: string, usd: number): Promise<void>;
  platformSpend(day: string): Promise<number>;
  close(): Promise<void>;
}

const roleFor = (email: string): User["role"] => (config.adminEmails.includes(email.toLowerCase()) ? "admin" : "user");
export const today = () => new Date().toISOString().slice(0, 10);

type Row = Record<string, unknown>;
const toUser = (r: Row): User => ({
  id: String(r.id), sub: String(r.sub), email: String(r.email), name: String(r.name ?? ""), picture: (r.picture as string) ?? null,
  role: (r.role as User["role"]) ?? "user", freeRunsUsed: Number(r.free_runs_used ?? 0), apiKeyEnc: (r.api_key_enc as string) ?? null,
  apiKeyLast4: (r.api_key_last4 as string) ?? null, createdAt: Number(r.created_at ?? 0),
});

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, sub TEXT UNIQUE NOT NULL, email TEXT NOT NULL, name TEXT, picture TEXT, role TEXT NOT NULL DEFAULT 'user',
  free_runs_used INTEGER NOT NULL DEFAULT 0, api_key_enc TEXT, api_key_last4 TEXT, created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS platform_spend (day TEXT PRIMARY KEY, usd DOUBLE PRECISION NOT NULL DEFAULT 0);`;

class SqliteAccounts implements AccountStore {
  private db: DatabaseSync;
  constructor(file = path.join(config.dataDir, "accounts.db")) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
  }
  async init() {
    this.db.exec(SCHEMA.replace(/DOUBLE PRECISION/g, "REAL"));
  }
  async upsertGoogleUser(p: { sub: string; email: string; name: string; picture: string | null }) {
    const role = roleFor(p.email);
    this.db.prepare(`INSERT INTO users (id, sub, email, name, picture, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(sub) DO UPDATE SET email = excluded.email, name = excluded.name, picture = excluded.picture, role = excluded.role`)
      .run(newId("usr"), p.sub, p.email, p.name, p.picture, role, Date.now());
    return toUser(this.db.prepare(`SELECT * FROM users WHERE sub = ?`).get(p.sub) as Row);
  }
  async getUser(id: string) {
    const r = this.db.prepare(`SELECT * FROM users WHERE id = ?`).get(id) as Row | undefined;
    return r ? toUser(r) : null;
  }
  async consumeFreeRun(userId: string, limit: number) {
    const r = this.db.prepare(`UPDATE users SET free_runs_used = free_runs_used + 1 WHERE id = ? AND free_runs_used < ?`).run(userId, limit);
    return Number(r.changes) === 1;
  }
  async refundFreeRun(userId: string) {
    this.db.prepare(`UPDATE users SET free_runs_used = MAX(0, free_runs_used - 1) WHERE id = ?`).run(userId);
  }
  async setApiKey(userId: string, enc: string | null, last4: string | null) {
    this.db.prepare(`UPDATE users SET api_key_enc = ?, api_key_last4 = ? WHERE id = ?`).run(enc, last4, userId);
  }
  async addPlatformSpend(day: string, usd: number) {
    this.db.prepare(`INSERT INTO platform_spend (day, usd) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET usd = usd + excluded.usd`).run(day, usd);
  }
  async platformSpend(day: string) {
    const r = this.db.prepare(`SELECT usd FROM platform_spend WHERE day = ?`).get(day) as { usd: number } | undefined;
    return Number(r?.usd ?? 0);
  }
  async close() {
    this.db.close();
  }
}

class PgAccounts implements AccountStore {
  private pool: pg.Pool;
  constructor(url: string) {
    // Hosted Postgres (Neon, Supabase, Render) requires TLS.
    this.pool = new pg.Pool({ connectionString: url, max: 4, ssl: /localhost|127\.0\.0\.1/.test(url) ? undefined : { rejectUnauthorized: false } });
  }
  async init() {
    await this.pool.query(SCHEMA);
  }
  async upsertGoogleUser(p: { sub: string; email: string; name: string; picture: string | null }) {
    const { rows } = await this.pool.query(
      `INSERT INTO users (id, sub, email, name, picture, role, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (sub) DO UPDATE SET email = EXCLUDED.email, name = EXCLUDED.name, picture = EXCLUDED.picture, role = EXCLUDED.role
       RETURNING *`,
      [newId("usr"), p.sub, p.email, p.name, p.picture, roleFor(p.email), Date.now()],
    );
    return toUser(rows[0]);
  }
  async getUser(id: string) {
    const { rows } = await this.pool.query(`SELECT * FROM users WHERE id = $1`, [id]);
    return rows[0] ? toUser(rows[0]) : null;
  }
  async consumeFreeRun(userId: string, limit: number) {
    const r = await this.pool.query(`UPDATE users SET free_runs_used = free_runs_used + 1 WHERE id = $1 AND free_runs_used < $2`, [userId, limit]);
    return r.rowCount === 1;
  }
  async refundFreeRun(userId: string) {
    await this.pool.query(`UPDATE users SET free_runs_used = GREATEST(0, free_runs_used - 1) WHERE id = $1`, [userId]);
  }
  async setApiKey(userId: string, enc: string | null, last4: string | null) {
    await this.pool.query(`UPDATE users SET api_key_enc = $1, api_key_last4 = $2 WHERE id = $3`, [enc, last4, userId]);
  }
  async addPlatformSpend(day: string, usd: number) {
    await this.pool.query(`INSERT INTO platform_spend (day, usd) VALUES ($1, $2) ON CONFLICT (day) DO UPDATE SET usd = platform_spend.usd + EXCLUDED.usd`, [day, usd]);
  }
  async platformSpend(day: string) {
    const { rows } = await this.pool.query(`SELECT usd FROM platform_spend WHERE day = $1`, [day]);
    return Number(rows[0]?.usd ?? 0);
  }
  async close() {
    await this.pool.end();
  }
}

export function createAccountStore(): AccountStore {
  return config.databaseUrl ? new PgAccounts(config.databaseUrl) : new SqliteAccounts();
}
