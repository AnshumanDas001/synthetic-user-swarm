import crypto from "node:crypto";

export function sha256(data: string | Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(6).toString("hex")}`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Small seeded PRNG (mulberry32) so repetitions are reproducible from (study seed, repetition).
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pagePath(url: string): string {
  try {
    const u = new URL(url);
    // Collapse ids ("/products/3", "/order/KC123456") so one page template is one page.
    return u.pathname
      .split("/")
      .map((seg) => (isIdSegment(seg) ? ":id" : seg))
      .join("/") || "/";
  } catch {
    return url;
  }
}

// Numeric ids, short prefixed ids ("KC123456"), UUIDs, ULIDs and hashes: anything that names one record.
function isIdSegment(seg: string): boolean {
  if (!seg) return false;
  if (/^\d+$/.test(seg) || /^[A-Za-z]{0,4}\d{3,}$/.test(seg)) return true;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return true;
  return seg.length >= 16 && /^[A-Za-z0-9_-]+$/.test(seg) && /\d/.test(seg) && /[A-Za-z]/.test(seg);
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

export function wordCount(s: string): number {
  return s.split(/\s+/).filter(Boolean).length;
}

export function firstWords(s: string, n: number): string {
  const words = s.split(/\s+/).filter(Boolean);
  return words.length > n ? words.slice(0, n).join(" ") + " …" : words.join(" ");
}

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const PHONE = /(?<!\d)(?:\+?\d[\d\s().-]{7,}\d)(?!\d)/g;
const CARD = /\b(?:\d[ -]?){13,19}\b/g;

// Redaction at capture time: emails, phone numbers and card-like numbers never reach stored logs.
export function redact(s: string): string {
  return s.replace(EMAIL, "[email]").replace(CARD, "[card]").replace(PHONE, "[phone]");
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

export function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function log(scope: string, ...args: unknown[]): void {
  if (process.env.SWARM_QUIET === "1") return;
  const t = new Date().toISOString().slice(11, 19);
  console.log(`[${t}] ${scope}:`, ...args);
}
