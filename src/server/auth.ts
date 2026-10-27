// Access control. Three modes:
//  - google:   GOOGLE_CLIENT_ID set. People sign in with Google; each sees only their own studies.
//              SWARM_PASSWORD (optional) adds an admin sign-in; SWARM_ADMIN_EMAILS marks Google admins.
//  - password: only SWARM_PASSWORD set. One admin login (the previous behaviour).
//  - local:    neither set. No login; the server only listens on localhost.
// Sessions are signed, HTTP-only cookies; scripts may use "Authorization: Bearer <SWARM_PASSWORD>" (admin).
import type { Express, NextFunction, Request, Response } from "express";
import { config, multiUser } from "../config.js";
import type { AccountStore, User } from "../store/accounts.js";
import { hmac, randomToken, safeEqual } from "../util/secrets.js";
import { authUrl, exchangeCode, pkcePair } from "./google.js";
import { log } from "../util/common.js";

const COOKIE = "swarm_session";
const OAUTH_COOKIE = "swarm_oauth";
const TTL_MS = 7 * 24 * 3600 * 1000;

export type AuthMode = "google" | "password" | "local";
export const authMode = (): AuthMode => (multiUser() ? "google" : process.env.SWARM_PASSWORD ? "password" : "local");
export const authEnabled = (): boolean => authMode() !== "local";

const ADMIN: User = { id: "admin", sub: "admin", email: "admin", name: "Admin", picture: null, role: "admin", freeRunsUsed: 0, apiKeyEnc: null, apiKeyLast4: null, createdAt: 0 };
const LOCAL: User = { ...ADMIN, id: "local", sub: "local", email: "local", name: "You" };

declare module "express-serve-static-core" {
  interface Request {
    user?: User;
  }
}

export function currentUser(req: Request): User {
  if (!req.user) throw new Error("not signed in");
  return req.user;
}

const sign = (userId: string, exp: number) => `v2.${userId}.${exp}.${hmac("session", `${userId}.${exp}`)}`;

function readSession(token: string | undefined): string | null {
  if (!token) return null;
  const [v, userId, exp, mac] = token.split(".");
  if (v !== "v2" || !userId || !exp || !mac || Number(exp) < Date.now()) return null;
  return safeEqual(mac, hmac("session", `${userId}.${exp}`)) ? userId : null;
}

function cookie(req: Request, name: string): string | undefined {
  const m = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(req.headers.cookie ?? "");
  return m ? decodeURIComponent(m[1]) : undefined;
}

const isSecure = (req: Request) => req.secure || req.headers["x-forwarded-proto"] === "https" || config.publicUrl.startsWith("https://");
const origin = (req: Request) => `${isSecure(req) ? "https" : "http"}://${req.headers.host}`;

function setCookie(res: Response, req: Request, name: string, value: string, maxAgeS: number) {
  res.append("Set-Cookie", `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeS}${isSecure(req) ? "; Secure" : ""}`);
}

function passwordMatches(given: string): boolean {
  const pw = process.env.SWARM_PASSWORD;
  return !!pw && safeEqual(hmac("pw", given), hmac("pw", pw));
}

const safeNext = (n: unknown) => (typeof n === "string" && n.startsWith("/") && !n.startsWith("//") ? n : "/");

export function installAuth(app: Express, accounts: AccountStore): void {
  const mode = authMode();
  if (mode === "local") {
    app.use((req, _res, next) => { req.user = LOCAL; next(); });
    return;
  }
  const attempts = new Map<string, { n: number; until: number }>();

  app.get("/login", (req, res) => res.type("html").send(loginHtml(mode, String(req.query.error ?? ""))));

  // ---------------- Google
  app.get("/auth/google", (req, res) => {
    if (mode !== "google") return res.redirect("/login");
    const state = randomToken(18);
    const nonce = randomToken(18);
    const { verifier, challenge } = pkcePair();
    const payload = [state, nonce, verifier, safeNext(req.query.next)].map((x) => Buffer.from(x).toString("base64url")).join(".");
    setCookie(res, req, OAUTH_COOKIE, `${payload}.${hmac("oauth", payload)}`, 600);
    res.redirect(authUrl({ origin: origin(req), state, nonce, challenge }));
  });

  app.get("/auth/google/callback", async (req, res) => {
    const fail = (msg: string) => res.redirect(`/login?error=${encodeURIComponent(msg)}`);
    try {
      if (req.query.error) return fail(String(req.query.error) === "access_denied" ? "Sign-in was cancelled." : `Google returned: ${req.query.error}`);
      const raw = cookie(req, OAUTH_COOKIE) ?? "";
      const parts = raw.split(".");
      const mac = parts.pop() ?? "";
      const payload = parts.join(".");
      if (!payload || !safeEqual(mac, hmac("oauth", payload))) return fail("Sign-in expired. Please try again.");
      const [state, nonce, verifier, next] = parts.map((x) => Buffer.from(x, "base64url").toString());
      if (!safeEqual(String(req.query.state ?? ""), state)) return fail("Sign-in could not be verified. Please try again.");
      const identity = await exchangeCode({ origin: origin(req), code: String(req.query.code ?? ""), verifier, nonce });
      const user = await accounts.upsertGoogleUser(identity);
      res.append("Set-Cookie", `${OAUTH_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
      setCookie(res, req, COOKIE, sign(user.id, Date.now() + TTL_MS), TTL_MS / 1000);
      log("auth", `signed in ${user.email} (${user.role})`);
      res.redirect(safeNext(next));
    } catch (e) {
      fail((e as Error).message);
    }
  });

  // ---------------- password (admin)
  app.post("/api/login", (req, res) => {
    const ip = req.ip ?? "?";
    const a = attempts.get(ip);
    if (a && a.n >= 5 && a.until > Date.now()) return res.status(429).json({ error: "Too many attempts; try again in a minute." });
    if (!passwordMatches(String(req.body?.password ?? ""))) {
      attempts.set(ip, { n: (a?.n ?? 0) + 1, until: Date.now() + 60_000 });
      return res.status(401).json({ error: "Wrong password." });
    }
    attempts.delete(ip);
    setCookie(res, req, COOKIE, sign("admin", Date.now() + TTL_MS), TTL_MS / 1000);
    res.json({ ok: true });
  });

  app.post("/api/logout", (req, res) => {
    setCookie(res, req, COOKIE, "", 0);
    res.json({ ok: true });
  });

  // ---------------- gate
  app.use(async (req: Request, res: Response, next: NextFunction) => {
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
    let user: User | null = null;
    if (bearer && passwordMatches(bearer)) user = ADMIN;
    else {
      const id = readSession(cookie(req, COOKIE));
      if (id === "admin" && process.env.SWARM_PASSWORD) user = ADMIN;
      else if (id && mode === "google") user = await accounts.getUser(id).catch(() => null);
    }
    if (user) {
      req.user = user;
      return next();
    }
    if (req.path.startsWith("/api/") || req.path.startsWith("/blobs/")) return res.status(401).json({ error: "Sign in required." });
    res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
  });
}

const GOOGLE_G = `<svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.3 0-9.7-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>`;

function loginHtml(mode: AuthMode, error: string): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  const pw = !!process.env.SWARM_PASSWORD;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in · Swarm</title><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap">
<style>
:root{--bg:#f6f6f8;--card:#fff;--text:#17171c;--muted:#6b6b78;--border:#e4e4e9;--accent:#4f46e5}
@media (prefers-color-scheme:dark){:root{--bg:#0e0e12;--card:#17171d;--text:#ececf1;--muted:#8a8a98;--border:#2a2a33;--accent:#7c74ff}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:radial-gradient(1200px 600px at 50% -10%,color-mix(in oklab,var(--accent) 18%,transparent),transparent),var(--bg);color:var(--text);font:14px/1.5 Inter,system-ui,sans-serif;padding:16px}
.card{width:min(400px,100%);background:var(--card);border:1px solid var(--border);border-radius:16px;padding:30px;box-shadow:0 20px 50px -20px rgba(0,0,0,.25)}
.logo{width:42px;height:42px;border-radius:11px;background:var(--accent);position:relative;margin-bottom:18px}
.logo i{position:absolute;width:9px;height:9px;border-radius:50%;background:#fff}.logo i:nth-child(1){left:9px;top:11px}.logo i:nth-child(2){right:9px;top:11px;opacity:.7}.logo i:nth-child(3){left:16.5px;bottom:9px;opacity:.85}
h1{font-size:21px;margin:0 0 4px;letter-spacing:-.01em}p.sub{margin:0 0 22px;color:var(--muted)}
.google{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;height:44px;border-radius:10px;border:1px solid #dadce0;background:#fff;color:#1f1f1f;font:500 14.5px Inter,system-ui,sans-serif;text-decoration:none;box-shadow:0 1px 2px rgba(0,0,0,.06)}
.google:hover{background:#f8f9fa;box-shadow:0 1px 3px rgba(0,0,0,.12)}
.or{display:flex;align-items:center;gap:10px;color:var(--muted);font-size:12px;margin:20px 0}.or::before,.or::after{content:"";flex:1;height:1px;background:var(--border)}
label{display:block;font-weight:550;font-size:13px;margin-bottom:6px}
input{width:100%;height:40px;border-radius:9px;border:1px solid var(--border);background:var(--bg);color:var(--text);padding:0 12px;font:inherit}
input:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in oklab,var(--accent) 22%,transparent)}
button{margin-top:12px;width:100%;height:40px;border:0;border-radius:9px;background:var(--accent);color:#fff;font:600 14px Inter,system-ui,sans-serif;cursor:pointer}
.err{color:#dc2626;font-size:13px;min-height:20px;margin-top:12px}.fine{margin-top:18px;color:var(--muted);font-size:12px;line-height:1.5}
</style></head><body><div class="card">
<div class="logo"><i></i><i></i><i></i></div><h1>Sign in to Swarm</h1><p class="sub">Synthetic users that test your site and show you where real people would struggle.</p>
${mode === "google" ? `<a class="google" id="g" href="/auth/google">${GOOGLE_G}<span>Sign in with Google</span></a>` : ""}
${mode === "google" && pw ? `<div class="or">admin</div>` : ""}
${pw ? `<form id="f"><label for="p">${mode === "google" ? "Admin password" : "Password"}</label><input id="p" type="password" autocomplete="current-password" ${mode === "google" ? "" : "autofocus"} required><button>Sign in</button></form>` : ""}
<div class="err" id="e" role="alert">${esc(error)}</div>
${mode === "google" ? `<p class="fine">We use your Google name, email and photo only to keep your studies private to you. New accounts get one free run; after that you can add your own OpenRouter API key.</p>` : ""}
</div>
<script>
const next = new URLSearchParams(location.search).get("next") || "/";
const g = document.getElementById("g"); if (g) g.href = "/auth/google?next=" + encodeURIComponent(next);
const f = document.getElementById("f");
if (f) f.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const r = await fetch("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: document.getElementById("p").value }) });
  if (r.ok) location.href = next.startsWith("/") && !next.startsWith("//") ? next : "/";
  else document.getElementById("e").textContent = (await r.json().catch(() => ({}))).error || "Sign-in failed";
});
</script></body></html>`;
}
