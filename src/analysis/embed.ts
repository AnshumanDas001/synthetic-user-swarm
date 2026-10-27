// Text embeddings for clustering and de-duplication. No embeddings API is called (it would spend credit), so the
// default is a deterministic hashed bag of words + character trigrams (offline, free, stable across runs).
// Plug in a hosted embedding model by replacing embedText; vectors are stored with each candidate.
const DIM = 512;

const STOP = new Set(
  "a an the and or of to in on for with is are was were be been it its this that at by from as not no can cant can't do does did i my me you your they them we our has have had but if so too very".split(" "),
);

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9/\s-]/g, " ")
    .split(/[\s-]+/)
    .filter((t) => t.length > 1 && !STOP.has(t));
}

export function embedText(text: string): number[] {
  const v = new Array<number>(DIM).fill(0);
  const toks = tokens(text);
  for (const t of toks) {
    const h = hash(t);
    v[h % DIM] += h & 1 ? 1 : -1;
    // Trigrams make "button"/"buttons" and "checkout"/"check-out" land near each other.
    const padded = `^${t}$`;
    for (let i = 0; i + 3 <= padded.length; i++) {
      const g = hash(padded.slice(i, i + 3));
      v[g % DIM] += (g & 1 ? 1 : -1) * 0.3;
    }
  }
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
}

export function cosine(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) s += a[i] * b[i];
  return s;
}
