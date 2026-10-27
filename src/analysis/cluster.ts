// Agglomerative clustering (average linkage, cosine distance) with a distance threshold, so no cluster
// count has to be picked up front. Candidates on different pages are kept apart unless their text is
// near-identical (a global component such as a cookie banner can appear on many pages).
import { cosine } from "./embed.js";

export interface Clusterable {
  embedding: number[];
  page: string;
  element: string;
}

export function agglomerative<T extends Clusterable>(items: T[], threshold = 0.42): T[][] {
  let clusters: number[][] = items.map((_, i) => [i]);
  const dist = (a: number, b: number) => {
    const base = 1 - cosine(items[a].embedding, items[b].embedding);
    const samePage = items[a].page === items[b].page;
    const sameEl = normalize(items[a].element) === normalize(items[b].element);
    // Page and element are strong evidence of the same root cause; reward them in the distance.
    return base - (samePage ? 0.12 : -0.15) - (sameEl ? 0.15 : 0);
  };
  const cache = new Map<string, number>();
  const d = (a: number, b: number) => {
    const k = a < b ? `${a}:${b}` : `${b}:${a}`;
    let v = cache.get(k);
    if (v === undefined) cache.set(k, (v = dist(a, b)));
    return v;
  };
  const linkage = (A: number[], B: number[]) => {
    let s = 0;
    for (const a of A) for (const b of B) s += d(a, b);
    return s / (A.length * B.length);
  };

  for (;;) {
    let best = Infinity;
    let pair: [number, number] | null = null;
    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        const l = linkage(clusters[i], clusters[j]);
        if (l < best) {
          best = l;
          pair = [i, j];
        }
      }
    }
    if (!pair || best > threshold) break;
    const [i, j] = pair;
    clusters[i] = [...clusters[i], ...clusters[j]];
    clusters = clusters.filter((_, k) => k !== j);
  }
  return clusters.map((c) => c.map((i) => items[i]));
}

export function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
