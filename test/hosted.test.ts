// Hosted-mode building blocks: SSRF guard, key encryption, Google ID-token verification, free-run accounting.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.SWARM_SECRET = "test-secret-for-hosted-mode";
process.env.GOOGLE_CLIENT_ID = "test-client.apps.googleusercontent.com";
process.env.SWARM_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-hosted-"));

let guard: typeof import("../src/runtime/netguard.js");
let secrets: typeof import("../src/util/secrets.js");
let google: typeof import("../src/server/google.js");
let accounts: typeof import("../src/store/accounts.js");

beforeAll(async () => {
  guard = await import("../src/runtime/netguard.js");
  secrets = await import("../src/util/secrets.js");
  google = await import("../src/server/google.js");
  accounts = await import("../src/store/accounts.js");
});
afterEach(() => vi.unstubAllGlobals());

describe("SSRF guard (hosted mode)", () => {
  it("classifies private, loopback, link-local and metadata addresses", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "0.0.0.0", "100.64.0.1", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1"]) {
      expect(guard.isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ["8.8.8.8", "104.21.3.4", "2606:4700::1111"]) expect(guard.isPrivateAddress(ip), ip).toBe(false);
  });
  it("refuses non-http schemes and private hosts", async () => {
    expect(await guard.urlIsSafe("file:///etc/passwd")).toBe(false);
    expect(await guard.urlIsSafe("http://127.0.0.1:4300/api/studies")).toBe(false);
    expect(await guard.urlIsSafe("http://169.254.169.254/latest/meta-data/")).toBe(false);
    expect(await guard.urlIsSafe("http://localhost:4300/")).toBe(false);
    expect(await guard.urlIsSafe("http://[::1]/")).toBe(false);
    await expect(guard.assertUrlSafe("http://10.0.0.5/", "target_url")).rejects.toThrow(/public http/);
  });
});

describe("API key encryption", () => {
  it("round-trips, and tampering is detected", () => {
    const enc = secrets.encrypt("sk-or-v1-abc123");
    expect(enc).not.toContain("abc123");
    expect(secrets.decrypt(enc)).toBe("sk-or-v1-abc123");
    const parts = enc.split(".");
    parts[3] = Buffer.from("tampered").toString("base64url");
    expect(() => secrets.decrypt(parts.join("."))).toThrow();
  });
});

describe("Google ID token verification", () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...(publicKey.export({ format: "jwk" }) as Record<string, unknown>), kid: "k1", alg: "RS256", use: "sig" };
  const sign = (claims: Record<string, unknown>, kid = "k1") => {
    const h = Buffer.from(JSON.stringify({ alg: "RS256", kid, typ: "JWT" })).toString("base64url");
    const p = Buffer.from(JSON.stringify(claims)).toString("base64url");
    return `${h}.${p}.${crypto.sign("RSA-SHA256", Buffer.from(`${h}.${p}`), privateKey).toString("base64url")}`;
  };
  const now = Math.floor(Date.now() / 1000);
  const good = { iss: "https://accounts.google.com", aud: process.env.GOOGLE_CLIENT_ID, sub: "123", email: "a@b.com", email_verified: true, exp: now + 300, nonce: "n1" };
  const stubJwks = () => vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ keys: [jwk] }))));

  it("accepts a correctly signed token for this app", async () => {
    stubJwks();
    expect((await google.verifyIdToken(sign(good))).sub).toBe("123");
  });
  it("rejects a forged signature, another app's token, a wrong issuer and an expired token", async () => {
    stubJwks();
    const forged = sign(good).split(".");
    forged[1] = Buffer.from(JSON.stringify({ ...good, sub: "attacker" })).toString("base64url");
    await expect(google.verifyIdToken(forged.join("."))).rejects.toThrow(/signature/);
    await expect(google.verifyIdToken(sign({ ...good, aud: "other-app" }))).rejects.toThrow(/not issued for this app/);
    await expect(google.verifyIdToken(sign({ ...good, iss: "https://evil.example" }))).rejects.toThrow(/issuer/);
    await expect(google.verifyIdToken(sign({ ...good, exp: now - 3600 }))).rejects.toThrow(/expired/);
  });
  it("builds a PKCE authorization URL with state and nonce", () => {
    const { challenge, verifier } = google.pkcePair();
    expect(crypto.createHash("sha256").update(verifier).digest("base64url")).toBe(challenge);
    const url = new URL(google.authUrl({ origin: "https://swarm.example", state: "s", nonce: "n", challenge }));
    expect(url.searchParams.get("redirect_uri")).toBe("https://swarm.example/auth/google/callback");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")).toBe("openid email profile");
  });
});

describe("free-run accounting", () => {
  it("lets each user take exactly the allowed number of free runs, atomically", async () => {
    const store = accounts.createAccountStore();
    await store.init();
    const u = await store.upsertGoogleUser({ sub: "g-1", email: "x@y.com", name: "X", picture: null });
    const results = await Promise.all([store.consumeFreeRun(u.id, 1), store.consumeFreeRun(u.id, 1), store.consumeFreeRun(u.id, 1)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    await store.refundFreeRun(u.id);
    expect(await store.consumeFreeRun(u.id, 1)).toBe(true);
    await store.addPlatformSpend("2026-10-27", 0.04);
    await store.addPlatformSpend("2026-10-27", 0.03);
    expect(await store.platformSpend("2026-10-27")).toBeCloseTo(0.07, 5);
    await store.close();
  });
});
