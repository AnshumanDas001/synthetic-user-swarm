"""Text embeddings for clustering and de-duplication. No embeddings API is called (it would spend credit), so the
default is a deterministic hashed bag of words + character trigrams (offline, free, stable across runs).
Plug in a hosted embedding model by replacing embed_text; vectors are stored with each candidate."""
from __future__ import annotations

import math
import re

DIM = 512

STOP = set(
    "a an the and or of to in on for with is are was were be been it its this that at by from as not no can cant can't do does did i my me you your they them we our has have had but if so too very".split()
)


def _hash(s: str) -> int:
    """FNV-1a over UTF-16 code units, identical to the TypeScript version so stored vectors stay comparable."""
    h = 2166136261
    for ch in s.encode("utf-16-le").decode("utf-16-le"):
        code = ord(ch)
        units = [code] if code < 0x10000 else [0xD800 + ((code - 0x10000) >> 10), 0xDC00 + ((code - 0x10000) & 0x3FF)]
        for u in units:
            h ^= u
            h = (h * 16777619) & 0xFFFFFFFF
    return h


def tokens(text: str) -> list[str]:
    cleaned = re.sub(r"[^a-z0-9/\s-]", " ", text.lower())
    return [t for t in re.split(r"[\s-]+", cleaned) if len(t) > 1 and t not in STOP]


def embed_text(text: str) -> list[float]:
    v = [0.0] * DIM
    for t in tokens(text):
        h = _hash(t)
        v[h % DIM] += 1 if h & 1 else -1
        # Trigrams make "button"/"buttons" and "checkout"/"check-out" land near each other.
        padded = f"^{t}$"
        for i in range(len(padded) - 2):
            g = _hash(padded[i:i + 3])
            v[g % DIM] += (1 if g & 1 else -1) * 0.3
    norm = math.sqrt(sum(x * x for x in v)) or 1
    return [x / norm for x in v]


def cosine(a: list[float], b: list[float]) -> float:
    return sum(x * y for x, y in zip(a, b))
