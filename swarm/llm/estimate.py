"""Pre-run cost estimate, so a study's spend is known before it touches the OpenRouter balance. Token figures are
typical for this app: one downscaled screenshot plus persona prompt, element list and history per step; the critic
reads a whole session. Estimates use list prices, so they run high."""
from __future__ import annotations

from ..config import config
from ..models import StudySpec
from .client import model_catalogue

STEP_IN = 4900   # measured on the demo shop; list price, so cache hits make the real bill lower
STEP_OUT = 450   # JSON decision plus low-effort reasoning
CRITIC_IN = 12000
CRITIC_OUT = 2500


async def estimate_study(spec: StudySpec, persona_count: int, avg_steps: int = 14) -> dict:
    cat = await model_catalogue()
    price = lambda m: cat.get(m) or {"in": 0, "out": 0}  # noqa: E731
    sessions = persona_count * len(spec.tasks) * spec.budget.repetitions
    steps = min(avg_steps, spec.budget.max_steps or avg_steps)
    step, critic = price(config.models.step), price(config.models.critic)
    per_step = (STEP_IN * step["in"] + STEP_OUT * step["out"]) / 1e6
    per_critic = (CRITIC_IN * critic["in"] + CRITIC_OUT * critic["out"]) / 1e6
    return {
        "sessions": sessions, "assumedStepsPerSession": steps, "models": {"step": config.models.step, "critic": config.models.critic},
        "perStepUsd": per_step, "perSessionUsd": steps * per_step + per_critic, "totalUsd": sessions * (steps * per_step + per_critic),
        "worstCaseUsd": sessions * ((spec.budget.max_steps or 30) * per_step + per_critic), "capUsd": spec.budget.cost_cap_usd,
    }
