"""Generated personas: an LLM fills the persona schema from a segment description such as
"Indian small-business owners, 30-55, mostly Android". Output is schema-validated like curated cards."""
from __future__ import annotations

import re
from typing import Literal, Optional

from pydantic import BaseModel

from ..config import config
from ..llm.client import structured, text_block
from ..models import PersonaCard
from ..util import rng


class GeneratedPersona(BaseModel):
    """LLM-facing shape: flat and constraint-free; ranges are enforced by PersonaCard afterwards."""
    name: str
    archetype: str
    locale: str
    non_native: bool
    viewport: str
    touch: bool
    network: Literal["fast", "4g", "slow-4g", "3g"]
    digital_literacy: int
    domain_knowledge: int
    goal_framing: str
    reading: Literal["skim", "normal", "thorough"]
    max_steps: int
    max_retries_per_obstacle: int
    zoom: float
    screen_reader: bool
    keyboard_only: bool
    quirks: list[str]
    vocabulary_gaps: list[str]


class GeneratedBatch(BaseModel):
    personas: list[GeneratedPersona]


SYSTEM = """You design realistic synthetic users for usability testing.
Given a segment description, produce distinct people who would plausibly visit the site.
Spread them across the trait axes (device, literacy, reading style, patience, language) instead of
making near-copies. Quirks must be concrete, observable behaviours ("closes pop-ups without reading them"),
not personality adjectives. Viewport is "WIDTHxHEIGHT" in CSS pixels (phones ~360-430 wide).
digital_literacy and domain_knowledge are 1-5. max_steps is 10-40. zoom is a percentage (100 = none).
Only set screen_reader or keyboard_only when the segment plausibly includes assistive-tech users."""


def _clamp_int(n: float, lo: int, hi: int) -> int:
    return max(lo, min(hi, round(n)))


async def generate_personas(segment: str, count: int, seed: int) -> tuple[list[PersonaCard], Optional[dict]]:
    if config.model_mode == "mock":
        return _mock_generate(segment, count, seed), None
    value, usage = await structured(model=config.models.generator, schema=GeneratedBatch, system=SYSTEM,
                                    content=[text_block(f"Segment: {segment}\nNumber of personas: {count}")], effort="medium", name="personas")
    slug = re.sub(r"-+$", "", re.sub(r"[^a-z0-9]+", "-", segment.lower())[:24])
    cards = [
        PersonaCard.model_validate({
            "id": f"gen-{slug}-{i + 1}", "name": g.name, "archetype": g.archetype, "locale": g.locale, "non_native": g.non_native,
            "device": {"viewport": g.viewport if re.fullmatch(r"\d+x\d+", g.viewport) else "390x844", "touch": g.touch, "network": g.network},
            "digital_literacy": _clamp_int(g.digital_literacy, 1, 5), "domain_knowledge": _clamp_int(g.domain_knowledge, 1, 5),
            "goal_framing": g.goal_framing, "reading": g.reading,
            "patience": {"max_steps": _clamp_int(g.max_steps, 5, 60), "max_retries_per_obstacle": _clamp_int(g.max_retries_per_obstacle, 0, 5)},
            "accessibility": {"zoom": _clamp_int(g.zoom, 100, 300), "screen_reader": g.screen_reader, "keyboard_only": g.keyboard_only},
            "quirks": g.quirks, "vocabulary_gaps": g.vocabulary_gaps, "tags": ["generated", slug],
        })
        for i, g in enumerate(value.personas[:count])
    ]
    return cards, usage


def _mock_generate(segment: str, count: int, seed: int) -> list[PersonaCard]:
    """Offline generator: varies traits deterministically so tests and CI need no API key."""
    rand = rng(seed)
    devices = [("390x844", True), ("412x915", True), ("1440x900", False), ("1280x800", False)]
    out = []
    for i in range(count):
        viewport, touch = devices[int(rand() * len(devices))]
        out.append(PersonaCard.model_validate({
            "id": f"gen-mock-{i + 1}", "name": f"Generated {i + 1}", "archetype": segment,
            "device": {"viewport": viewport, "touch": touch, "network": "4g" if touch else "fast"},
            "digital_literacy": 1 + int(rand() * 5), "domain_knowledge": 1 + int(rand() * 5),
            "reading": ["skim", "normal", "thorough"][int(rand() * 3)], "tags": ["generated"],
        }))
    return out
