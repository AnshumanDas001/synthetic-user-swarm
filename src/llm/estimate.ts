// Pre-run cost estimate, so a study's spend is known before it touches the OpenRouter balance.
// Token figures are typical for this app: one downscaled screenshot plus persona prompt, element list
// and history per step; the critic reads a whole session. Estimates use list prices, so they run high.
import { config } from "../config.js";
import { modelCatalogue } from "./client.js";
import type { StudySpec } from "../types.js";

const STEP_IN = 4900;      // measured on the demo shop; list price, so cache hits make the real bill lower
const STEP_OUT = 450;      // JSON decision plus low-effort reasoning
const CRITIC_IN = 12000;
const CRITIC_OUT = 2500;

export async function estimateStudy(spec: StudySpec, personaCount: number, avgSteps = 14) {
  const cat = await modelCatalogue();
  const price = (m: string) => cat.get(m) ?? { in: 0, out: 0 };
  const sessions = personaCount * spec.tasks.length * spec.budget.repetitions;
  const steps = Math.min(avgSteps, spec.budget.max_steps ?? avgSteps);
  const step = price(config.models.step);
  const critic = price(config.models.critic);
  const perStep = (STEP_IN * step.in + STEP_OUT * step.out) / 1e6;
  const perCritic = (CRITIC_IN * critic.in + CRITIC_OUT * critic.out) / 1e6;
  const total = sessions * (steps * perStep + perCritic);
  return {
    sessions, assumedStepsPerSession: steps, models: { step: config.models.step, critic: config.models.critic },
    perStepUsd: perStep, perSessionUsd: steps * perStep + perCritic, totalUsd: total,
    worstCaseUsd: sessions * ((spec.budget.max_steps ?? 30) * perStep + perCritic),
    capUsd: spec.budget.cost_cap_usd,
  };
}
