// Sign in with Google: OpenID Connect authorization-code flow with PKCE, state and nonce.
// The ID token's RS256 signature is verified against Google's published keys (JWKS), then its claims.
import crypto from "node:crypto";
import { config } from "../config.js";

const AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN = "https://oauth2.googleapis.com/token";
const JWKS = "https://www.googleapis.com/oauth2/v3/certs";
const ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

export function redirectUri(origin: string): string {
  return `${config.publicUrl || origin}/auth/google/callback`;
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString("base64url");
  return { verifier, challenge: crypto.createHash("sha256").update(verifier).digest("base64url") };
}

export function authUrl(p: { origin: string; state: string; nonce: string; challenge: string }): string {
  const q = new URLSearchParams({
    client_id: config.google.clientId,
    redirect_uri: redirectUri(p.origin),
    response_type: "code",
    scope: "openid email profile",
    state: p.state,
    nonce: p.nonce,
    code_challenge: p.challenge,
    code_challenge_method: "S256",
    prompt: "select_account",
  });
  return `${AUTH}?${q}`;
}

export interface GoogleIdentity {
  sub: string;
  email: string;
  name: string;
  picture: string | null;
}

export async function exchangeCode(p: { origin: string; code: string; verifier: string; nonce: string }): Promise<GoogleIdentity> {
  const res = await fetch(TOKEN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: p.code,
      client_id: config.google.clientId,
      client_secret: config.google.clientSecret,
      redirect_uri: redirectUri(p.origin),
      grant_type: "authorization_code",
      code_verifier: p.verifier,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json()) as { id_token?: string; error?: string; error_description?: string };
  if (!res.ok || !json.id_token) throw new Error(`Google sign-in failed: ${json.error_description ?? json.error ?? res.status}`);
  const claims = await verifyIdToken(json.id_token);
  if (claims.nonce !== p.nonce) throw new Error("Google sign-in failed: nonce mismatch");
  if (!claims.email || claims.email_verified !== true) throw new Error("Google sign-in failed: the account's email is not verified");
  return { sub: String(claims.sub), email: String(claims.email), name: String(claims.name ?? claims.email), picture: (claims.picture as string) ?? null };
}

let jwks: { keys: (Record<string, unknown> & { kid: string })[]; at: number } | null = null;

async function keyFor(kid: string): Promise<crypto.KeyObject> {
  if (!jwks || Date.now() - jwks.at > 3600_000 || !jwks.keys.some((k) => k.kid === kid)) {
    const r = await fetch(JWKS, { signal: AbortSignal.timeout(10_000) });
    jwks = { keys: ((await r.json()) as { keys: (Record<string, unknown> & { kid: string })[] }).keys, at: Date.now() };
  }
  const jwk = jwks.keys.find((k) => k.kid === kid);
  if (!jwk) throw new Error("Google sign-in failed: unknown signing key");
  return crypto.createPublicKey({ key: jwk as never, format: "jwk" });
}

export async function verifyIdToken(token: string): Promise<Record<string, unknown>> {
  const [h, p, s] = token.split(".");
  if (!h || !p || !s) throw new Error("Google sign-in failed: malformed token");
  const header = JSON.parse(Buffer.from(h, "base64url").toString()) as { alg: string; kid: string };
  if (header.alg !== "RS256") throw new Error("Google sign-in failed: unexpected token algorithm");
  const ok = crypto.verify("RSA-SHA256", Buffer.from(`${h}.${p}`), await keyFor(header.kid), Buffer.from(s, "base64url"));
  if (!ok) throw new Error("Google sign-in failed: bad token signature");
  const claims = JSON.parse(Buffer.from(p, "base64url").toString()) as Record<string, unknown>;
  const now = Math.floor(Date.now() / 1000);
  if (!ISSUERS.includes(String(claims.iss))) throw new Error("Google sign-in failed: wrong issuer");
  if (claims.aud !== config.google.clientId) throw new Error("Google sign-in failed: token not issued for this app");
  if (Number(claims.exp) < now - 60) throw new Error("Google sign-in failed: token expired");
  return claims;
}
