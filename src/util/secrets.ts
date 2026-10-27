// Server secret and at-rest encryption for user API keys (AES-256-GCM).
import crypto from "node:crypto";

export function serverSecret(): string {
  const s = process.env.SWARM_SECRET ?? process.env.SWARM_PASSWORD;
  if (!s) throw new Error("SWARM_SECRET is required for sign-in and key storage (any long random string)");
  return s;
}

function key(purpose: string): Buffer {
  return crypto.createHash("sha256").update(`${purpose}:${serverSecret()}`).digest();
}

export function hmac(purpose: string, data: string): string {
  return crypto.createHmac("sha256", key(purpose)).update(data).digest("base64url");
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key("api-keys"), iv);
  const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return `v1.${iv.toString("base64url")}.${c.getAuthTag().toString("base64url")}.${body.toString("base64url")}`;
}

export function decrypt(token: string): string {
  const [v, iv, tag, body] = token.split(".");
  if (v !== "v1") throw new Error("unknown key format");
  const d = crypto.createDecipheriv("aes-256-gcm", key("api-keys"), Buffer.from(iv, "base64url"));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(body, "base64url")), d.final()]).toString("utf8");
}

export function randomToken(bytes = 24): string {
  return crypto.randomBytes(bytes).toString("base64url");
}
