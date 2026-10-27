// Generated personas: an LLM fills the persona schema from a segment description such as
// "Indian small-business owners, 30–55, mostly Android". Output is schema-validated like curated cards.
import { z } from "zod";
import { config } from "../config.js";
import { structured, textBlock, type LlmUsage } from "../llm/client.js";
import { PersonaCard } from "../types.js";
import { rng } from "../util/common.js";

// LLM-facing shape: flat and constraint-free; ranges are enforced by PersonaCard.parse afterwards.
const GeneratedPersona = z.object({
  name: z.string(),
  archetype: z.string(),
  locale: z.string(),
  non_native: z.boolean(),
  viewport: z.string(),
  touch: z.boolean(),
  network: z.enum(["fast", "4g", "slow-4g", "3g"]),
  digital_literacy: z.number().int(),
  domain_knowledge: z.number().int(),
  goal_framing: z.string(),
  reading: z.enum(["skim", "normal", "thorough"]),
  max_steps: z.number().int(),
  max_retries_per_obstacle: z.number().int(),
  zoom: z.number(),
  screen_reader: z.boolean(),
  keyboard_only: z.boolean(),
  quirks: z.array(z.string()),
  vocabulary_gaps: z.array(z.string()),
});
const GeneratedBatch = z.object({ personas: z.array(GeneratedPersona) });

const SYSTEM = `You design realistic synthetic users for usability testing.
Given a segment description, produce distinct people who would plausibly visit the site.
Spread them across the trait axes (device, literacy, reading style, patience, language) instead of
making near-copies. Quirks must be concrete, observable behaviours ("closes pop-ups without reading them"),
not personality adjectives. Viewport is "WIDTHxHEIGHT" in CSS pixels (phones ~360-430 wide).
digital_literacy and domain_knowledge are 1-5. max_steps is 10-40. zoom is a percentage (100 = none).
Only set screen_reader or keyboard_only when the segment plausibly includes assistive-tech users.`;

export async function generatePersonas(segment: string, count: number, seed: number): Promise<{ cards: PersonaCard[]; usage: LlmUsage | null }> {
  if (config.modelMode === "mock") return { cards: mockGenerate(segment, count, seed), usage: null };

  const { value, usage } = await structured({
    model: config.models.generator,
    schema: GeneratedBatch,
    system: SYSTEM,
    content: [textBlock(`Segment: ${segment}\nNumber of personas: ${count}`)],
    effort: "medium",
    name: "personas",
  });
  const slug = segment.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 24).replace(/-+$/, "");
  const cards = value.personas.slice(0, count).map((g, i) =>
    PersonaCard.parse({
      id: `gen-${slug}-${i + 1}`,
      name: g.name,
      archetype: g.archetype,
      locale: g.locale,
      non_native: g.non_native,
      device: { viewport: /^\d+x\d+$/.test(g.viewport) ? g.viewport : "390x844", touch: g.touch, network: g.network },
      digital_literacy: clampInt(g.digital_literacy, 1, 5),
      domain_knowledge: clampInt(g.domain_knowledge, 1, 5),
      goal_framing: g.goal_framing,
      reading: g.reading,
      patience: { max_steps: clampInt(g.max_steps, 5, 60), max_retries_per_obstacle: clampInt(g.max_retries_per_obstacle, 0, 5) },
      accessibility: { zoom: clampInt(g.zoom, 100, 300), screen_reader: g.screen_reader, keyboard_only: g.keyboard_only },
      quirks: g.quirks,
      vocabulary_gaps: g.vocabulary_gaps,
      tags: ["generated", slug],
    }),
  );
  return { cards, usage };
}

function clampInt(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

// Offline generator: varies traits deterministically so tests and CI need no API key.
function mockGenerate(segment: string, count: number, seed: number): PersonaCard[] {
  const rand = rng(seed);
  const devices = [["390x844", true], ["412x915", true], ["1440x900", false], ["1280x800", false]] as const;
  return Array.from({ length: count }, (_, i) => {
    const [viewport, touch] = devices[Math.floor(rand() * devices.length)];
    return PersonaCard.parse({
      id: `gen-mock-${i + 1}`,
      name: `Generated ${i + 1}`,
      archetype: segment,
      device: { viewport, touch, network: touch ? "4g" : "fast" },
      digital_literacy: 1 + Math.floor(rand() * 5),
      domain_knowledge: 1 + Math.floor(rand() * 5),
      reading: (["skim", "normal", "thorough"] as const)[Math.floor(rand() * 3)],
      tags: ["generated"],
    });
  });
}
