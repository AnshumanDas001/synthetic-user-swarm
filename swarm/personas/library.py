"""Persona sources (spec: "Where personas come from"): curated cards on disk, LLM-generated cards from a segment
description, and cards seeded from the site's own analytics. The sampler then stratifies across trait axes and
drops near-duplicates so N agents are not N copies of one user."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Optional

import yaml
from pydantic import ValidationError

from ..analysis.embed import cosine, embed_text
from ..config import ROOT
from ..models import PersonaCard, PersonaMix
from ..util import rng
from .profiles import is_mobile


def personas_dir() -> Path:
    local = Path.cwd() / "personas"
    return local if local.is_dir() else ROOT / "personas"


def load_curated_personas(dir: Optional[Path] = None) -> list[PersonaCard]:
    d = dir or personas_dir()
    if not d.is_dir():
        return []
    out = []
    for f in sorted(p for p in d.iterdir() if p.suffix in (".yaml", ".yml")):
        try:
            out.append(PersonaCard.model_validate(yaml.safe_load(f.read_text())))
        except ValidationError as e:
            raise ValueError(f"persona {f.name} failed schema validation: {e}") from e
    return out


def persona_text(c: PersonaCard) -> str:
    a = c.accessibility
    return " ".join([
        c.archetype, c.locale, "non-native" if c.non_native else "native", c.device.viewport, "touch" if c.device.touch else "pointer",
        c.device.network, f"literacy{c.digital_literacy}", f"domain{c.domain_knowledge}", c.reading,
        "screenreader" if a.screen_reader else "", "keyboardonly" if a.keyboard_only else "",
        a.color_vision if a.color_vision != "normal" else "", f"zoom{a.zoom:g}", *c.quirks, *c.tags,
    ])


def dedupe_personas(cards: list[PersonaCard], threshold: float = 0.92) -> list[PersonaCard]:
    """Drop near-duplicates by embedding similarity, keeping the first-seen (curated cards come first)."""
    kept: list[tuple[PersonaCard, list[float]]] = []
    for card in cards:
        vec = embed_text(persona_text(card))
        if any(cosine(v, vec) >= threshold for _, v in kept):
            continue
        kept.append((card, vec))
    return [c for c, _ in kept]


def stratified_sample(cards: list[PersonaCard], size: int, mobile_share: Optional[float], seed: int) -> list[PersonaCard]:
    """Hit the requested mobile share, then round-robin across accessibility, literacy and reading-style strata
    so edge cases are always represented."""
    if len(cards) <= size:
        return cards
    rand = rng(seed)

    def shuffle(xs: list) -> list:
        keyed = [(rand(), i, x) for i, x in enumerate(xs)]
        return [x for _, _, x in sorted(keyed, key=lambda k: (k[0], k[1]))]

    def stratum(c: PersonaCard) -> str:
        a = c.accessibility
        if a.screen_reader or a.keyboard_only or a.color_vision != "normal" or a.zoom > 100:
            return "a11y"
        lit = "low" if c.digital_literacy <= 2 else "high" if c.digital_literacy >= 4 else "mid"
        return f"lit{lit}-{c.reading}"

    def pick(pool: list[PersonaCard], n: int) -> list[PersonaCard]:
        groups: dict[str, list[PersonaCard]] = {}
        for c in shuffle(pool):
            groups.setdefault(stratum(c), []).append(c)
        out: list[PersonaCard] = []
        queues = list(groups.values())
        while len(out) < n and any(queues):
            for q in queues:
                if q and len(out) < n:
                    out.append(q.pop(0))
        return out

    if mobile_share is None:
        return pick(cards, size)
    mobile = [c for c in cards if is_mobile(c)]
    desktop = [c for c in cards if not is_mobile(c)]
    n_mobile = min(len(mobile), round(size * mobile_share))
    n_desktop = min(len(desktop), size - n_mobile)
    chosen = pick(mobile, n_mobile) + pick(desktop, n_desktop)
    if len(chosen) < size:  # backfill from whichever side has spare cards
        chosen += pick([c for c in cards if c not in chosen], size - len(chosen))
    return chosen


def seeded_personas(seed_file: str, count: int, seed: int) -> list[PersonaCard]:
    """Device mix and locales from the site's analytics export:
    {devices: [{viewport, touch, share, network?}], locales: [{locale, share, non_native?}], segments?: [...]}"""
    data = json.loads(Path(seed_file).read_text())
    rand = rng(seed)

    def draw(xs: list[dict]) -> dict:
        r = rand() * sum(x["share"] for x in xs)
        for x in xs:
            r -= x["share"]
            if r <= 0:
                return x
        return xs[-1]

    segments = data.get("segments") or [{"archetype": "typical visitor", "digital_literacy": 3, "share": 1}]
    out = []
    for i in range(count):
        d, l, s = draw(data["devices"]), draw(data["locales"]), draw(segments)
        out.append(PersonaCard.model_validate({
            "id": f"seeded-{i + 1}", "name": f"Visitor {i + 1}", "archetype": s["archetype"], "locale": l["locale"],
            "non_native": l.get("non_native", not l["locale"].startswith("en")),
            "device": {"viewport": d["viewport"], "touch": d["touch"], "network": d.get("network", "4g")},
            "digital_literacy": s["digital_literacy"], "domain_knowledge": 3,
            "reading": "skim" if rand() < 0.5 else "normal",
            "patience": {"max_steps": 20 + int(rand() * 15), "max_retries_per_obstacle": 1 + int(rand() * 2)},
            "tags": ["seeded"],
        }))
    return out


def resolve_curated(mix: PersonaMix, library: list[PersonaCard]) -> list[PersonaCard]:
    if not mix.include:
        return library
    by_id = {p.id: p for p in library}
    out = []
    for pid in mix.include:
        if pid not in by_id:
            raise ValueError(f'unknown persona id "{pid}" (known: {", ".join(by_id)})')
        out.append(by_id[pid])
    return out
