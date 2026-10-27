"""Small shared helpers."""
from __future__ import annotations

import hashlib
import os
import re
import secrets
import sys
import time
from urllib.parse import urlparse


def sha256(data: str | bytes) -> str:
    return hashlib.sha256(data.encode() if isinstance(data, str) else data).hexdigest()


def new_id(prefix: str) -> str:
    return f"{prefix}_{secrets.token_hex(6)}"


def now_ms() -> int:
    return int(time.time() * 1000)


def rng(seed: int):
    """Mulberry32, so repetitions are reproducible from (study seed, repetition)."""
    a = seed & 0xFFFFFFFF

    def nxt() -> float:
        nonlocal a
        a = (a + 0x6D2B79F5) & 0xFFFFFFFF
        t = a
        t = ((t ^ (t >> 15)) * (t | 1)) & 0xFFFFFFFF
        t ^= (t + (((t ^ (t >> 7)) * (t | 61)) & 0xFFFFFFFF)) & 0xFFFFFFFF
        return ((t ^ (t >> 14)) & 0xFFFFFFFF) / 4294967296

    return nxt


def _is_id_segment(seg: str) -> bool:
    """Numeric ids, short prefixed ids ("KC123456"), UUIDs, ULIDs and hashes: anything naming one record."""
    if not seg:
        return False
    if re.fullmatch(r"\d+", seg) or re.fullmatch(r"[A-Za-z]{0,4}\d{3,}", seg):
        return True
    if re.fullmatch(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}", seg):
        return True
    return len(seg) >= 16 and bool(re.fullmatch(r"[A-Za-z0-9_-]+", seg)) and bool(re.search(r"\d", seg)) and bool(re.search(r"[A-Za-z]", seg))


def page_path(url: str) -> str:
    """Collapse ids ("/products/3", "/order/KC123456") so one page template is one page."""
    try:
        p = urlparse(url).path or "/"
    except ValueError:
        return url
    return "/".join(":id" if _is_id_segment(s) else s for s in p.split("/")) or "/"


def host_of(url: str) -> str:
    try:
        return (urlparse(url).hostname or "").lower()
    except ValueError:
        return ""


def word_count(s: str) -> int:
    return len(s.split())


_EMAIL = re.compile(r"[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}", re.I)
_CARD = re.compile(r"\b(?:\d[ -]?){13,19}\b")
_PHONE = re.compile(r"(?<!\d)(?:\+?\d[\d\s().-]{7,}\d)(?!\d)")


def redact(s: str) -> str:
    """Redaction at capture time: emails, phone numbers and card-like numbers never reach stored logs."""
    return _PHONE.sub("[phone]", _CARD.sub("[card]", _EMAIL.sub("[email]", s)))


def clamp(n: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, n))


def median(xs: list[float]) -> float:
    if not xs:
        return 0
    s = sorted(xs)
    m = len(s) // 2
    return s[m] if len(s) % 2 else (s[m - 1] + s[m]) / 2


def log(scope: str, *args: object) -> None:
    if os.environ.get("SWARM_QUIET") == "1":
        return
    t = time.strftime("%H:%M:%S")
    print(f"[{t}] {scope}:", *args, file=sys.stderr, flush=True)
