"""Agglomerative clustering (average linkage, cosine distance) with a distance threshold, so no cluster count has
to be picked up front. Candidates on different pages are kept apart unless their text is near-identical (a global
component such as a cookie banner can appear on many pages)."""
from __future__ import annotations

import re

from .embed import cosine


def normalize(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", (s or "").lower()).strip()


def agglomerative(items: list[dict], threshold: float = 0.42) -> list[list[dict]]:
    """items need embedding, page and element."""
    clusters = [[i] for i in range(len(items))]
    cache: dict[tuple[int, int], float] = {}

    def d(a: int, b: int) -> float:
        k = (a, b) if a < b else (b, a)
        if k not in cache:
            base = 1 - cosine(items[a]["embedding"], items[b]["embedding"])
            same_page = items[a]["page"] == items[b]["page"]
            same_el = normalize(items[a]["element"]) == normalize(items[b]["element"])
            # Page and element are strong evidence of the same root cause; reward them in the distance.
            cache[k] = base - (0.12 if same_page else -0.15) - (0.15 if same_el else 0)
        return cache[k]

    def linkage(A: list[int], B: list[int]) -> float:
        return sum(d(a, b) for a in A for b in B) / (len(A) * len(B))

    while True:
        best, pair = float("inf"), None
        for i in range(len(clusters)):
            for j in range(i + 1, len(clusters)):
                v = linkage(clusters[i], clusters[j])
                if v < best:
                    best, pair = v, (i, j)
        if pair is None or best > threshold:
            break
        i, j = pair
        clusters[i] = clusters[i] + clusters[j]
        del clusters[j]
    return [[items[i] for i in c] for c in clusters]
