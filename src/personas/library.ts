// Persona sources (spec: "Where personas come from"): curated cards on disk, LLM-generated cards
// from a segment description, and cards seeded from the site's own analytics. The sampler then
// stratifies across trait axes and drops near-duplicates so N agents are not N copies of one user.
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { PersonaCard, type PersonaMix } from "../types.js";
import { embedText, cosine } from "../analysis/embed.js";
import { isMobile } from "./profiles.js";
import { rng } from "../util/common.js";

export function loadCuratedPersonas(dir = path.resolve("personas")): PersonaCard[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort()
    .map((f) => {
      const raw = YAML.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      const parsed = PersonaCard.safeParse(raw);
      if (!parsed.success) throw new Error(`persona ${f} failed schema validation: ${parsed.error.message}`);
      return parsed.data;
    });
}

export function personaText(c: PersonaCard): string {
  return [
    c.archetype, c.locale, c.non_native ? "non-native" : "native", c.device.viewport, c.device.touch ? "touch" : "pointer",
    c.device.network, `literacy${c.digital_literacy}`, `domain${c.domain_knowledge}`, c.reading,
    c.accessibility.screen_reader ? "screenreader" : "", c.accessibility.keyboard_only ? "keyboardonly" : "",
    c.accessibility.color_vision !== "normal" ? c.accessibility.color_vision : "", `zoom${c.accessibility.zoom}`,
    ...c.quirks, ...c.tags,
  ].join(" ");
}

// Drop near-duplicates by embedding similarity, keeping the first-seen (curated cards come first).
export function dedupePersonas(cards: PersonaCard[], threshold = 0.92): PersonaCard[] {
  const kept: { card: PersonaCard; vec: number[] }[] = [];
  for (const card of cards) {
    const vec = embedText(personaText(card));
    if (kept.some((k) => cosine(k.vec, vec) >= threshold)) continue;
    kept.push({ card, vec });
  }
  return kept.map((k) => k.card);
}

// Stratified pick: hit the requested mobile share, then round-robin across accessibility,
// literacy and reading-style strata so edge cases are always represented.
export function stratifiedSample(cards: PersonaCard[], size: number, mobileShare: number | undefined, seed: number): PersonaCard[] {
  if (cards.length <= size) return cards;
  const rand = rng(seed);
  const shuffle = <T>(xs: T[]) => xs.map((x) => [rand(), x] as const).sort((a, b) => a[0] - b[0]).map(([, x]) => x);
  const stratum = (c: PersonaCard) =>
    c.accessibility.screen_reader || c.accessibility.keyboard_only || c.accessibility.color_vision !== "normal" || c.accessibility.zoom > 100
      ? "a11y"
      : `lit${c.digital_literacy <= 2 ? "low" : c.digital_literacy >= 4 ? "high" : "mid"}-${c.reading}`;

  const pick = (pool: PersonaCard[], n: number): PersonaCard[] => {
    const groups = new Map<string, PersonaCard[]>();
    for (const c of shuffle(pool)) groups.set(stratum(c), [...(groups.get(stratum(c)) ?? []), c]);
    const out: PersonaCard[] = [];
    const queues = [...groups.values()];
    while (out.length < n && queues.some((q) => q.length)) {
      for (const q of queues) if (q.length && out.length < n) out.push(q.shift()!);
    }
    return out;
  };

  if (mobileShare === undefined) return pick(cards, size);
  const mobile = cards.filter(isMobile);
  const desktop = cards.filter((c) => !isMobile(c));
  const nMobile = Math.min(mobile.length, Math.round(size * mobileShare));
  const nDesktop = Math.min(desktop.length, size - nMobile);
  const chosen = [...pick(mobile, nMobile), ...pick(desktop, nDesktop)];
  // Backfill from whichever side has spare cards if one side ran short.
  if (chosen.length < size) chosen.push(...pick(cards.filter((c) => !chosen.includes(c)), size - chosen.length));
  return chosen;
}

// Seeded personas: device mix and locales from the site's analytics export.
// Expected shape: { devices: [{viewport, touch, share}], locales: [{locale, share}], networks?: [...] }
export interface AnalyticsSeed {
  devices: { viewport: string; touch: boolean; share: number; network?: PersonaCard["device"]["network"] }[];
  locales: { locale: string; share: number; non_native?: boolean }[];
  segments?: { archetype: string; digital_literacy: number; share: number }[];
}

export function seededPersonas(seedFile: string, count: number, seed: number): PersonaCard[] {
  const data = JSON.parse(fs.readFileSync(seedFile, "utf8")) as AnalyticsSeed;
  const rand = rng(seed);
  const draw = <T extends { share: number }>(xs: T[]): T => {
    const total = xs.reduce((s, x) => s + x.share, 0);
    let r = rand() * total;
    for (const x of xs) if ((r -= x.share) <= 0) return x;
    return xs[xs.length - 1];
  };
  const segments = data.segments?.length ? data.segments : [{ archetype: "typical visitor", digital_literacy: 3, share: 1 }];
  return Array.from({ length: count }, (_, i) => {
    const d = draw(data.devices);
    const l = draw(data.locales);
    const s = draw(segments);
    return PersonaCard.parse({
      id: `seeded-${i + 1}`,
      name: `Visitor ${i + 1}`,
      archetype: s.archetype,
      locale: l.locale,
      non_native: l.non_native ?? !l.locale.startsWith("en"),
      device: { viewport: d.viewport, touch: d.touch, network: d.network ?? "4g" },
      digital_literacy: s.digital_literacy,
      domain_knowledge: 3,
      reading: rand() < 0.5 ? "skim" : "normal",
      patience: { max_steps: 20 + Math.floor(rand() * 15), max_retries_per_obstacle: 1 + Math.floor(rand() * 2) },
      tags: ["seeded"],
    });
  });
}

export interface ResolvedMix {
  cards: PersonaCard[];
  generatedSegments: PersonaMix["generate"];
}

export function resolveCurated(mix: PersonaMix, library: PersonaCard[]): PersonaCard[] {
  if (!mix.include.length) return library;
  return mix.include.map((id) => {
    const c = library.find((p) => p.id === id);
    if (!c) throw new Error(`unknown persona id "${id}" (known: ${library.map((p) => p.id).join(", ")})`);
    return c;
  });
}
