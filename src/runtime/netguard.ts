// SSRF guard for hosted (multi-user) mode: user-supplied studies must not reach this server, its private
// network, cloud metadata (169.254.169.254) or local files. Hostnames are resolved and every address checked,
// at plan time and again for each browser request (so DNS rebinding cannot slip past a one-time check).
import dns from "node:dns/promises";
import net from "node:net";
import { config, multiUser } from "../config.js";

export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const x = ip.toLowerCase();
    if (x === "::" || x === "::1") return true;
    if (x.startsWith("::ffff:")) return isPrivateAddress(x.slice(7));
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(x);
  }
  return true; // not an IP at all: treat as unsafe
}

const allowedPrivate = (host: string, port: string) =>
  [...config.privateHostsAllowed, ...(config.demoShop ? [`localhost:${config.demoShopPort}`, `127.0.0.1:${config.demoShopPort}`] : [])]
    .some((h) => h === host || h === `${host}:${port}`);

const cache = new Map<string, { ok: boolean; at: number }>();

// True when the browser (or the server) may fetch this URL.
export async function urlIsSafe(raw: string): Promise<boolean> {
  if (!multiUser()) return true;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol === "data:" || u.protocol === "blob:" || u.protocol === "about:") return true;
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const port = u.port || (u.protocol === "https:" ? "443" : "80");
  if (allowedPrivate(host, port)) return true;
  const key = `${host}:${port}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.ok;
  let ok = false;
  try {
    const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
    ok = addrs.length > 0 && addrs.every((a) => !isPrivateAddress(a.address));
  } catch {
    ok = false;
  }
  cache.set(key, { ok, at: Date.now() });
  return ok;
}

export async function assertUrlSafe(raw: string, what: string): Promise<void> {
  if (!(await urlIsSafe(raw))) throw new Error(`${what} must be a public http(s) address (${raw} is not allowed here)`);
}
