"""The "no evidence, no issue" gate. A candidate from the critic survives only if every cited step id exists in
this session, the named element appears in those steps (as the action target, in the element list, or in the
think-aloud), and it has a deterministic signal or a verbatim agent quote behind it."""
from __future__ import annotations

import math

from ..models import CandidateDraft
from .cluster import normalize


def _overlap(hay: str, needle: str) -> float:
    h = set(hay.split(" "))
    n = needle.split(" ")
    return sum(1 for w in n if w in h) / len(n)


def validate_candidate(c: CandidateDraft, steps: list[dict], signals: list[dict], element_names_by_step: dict[str, list[str]]) -> dict:
    reasons: list[str] = []
    by_id = {s["id"]: s for s in steps}
    cited = [by_id[i] for i in c.step_ids if i in by_id]
    missing = [i for i in c.step_ids if i not in by_id]
    if missing:
        reasons.append(f"cites step ids that do not exist: {', '.join(missing)}")
    if not cited:
        reasons.append("cites no existing steps")

    el = normalize(c.element)
    raw = c.element.strip()

    def seen(s: dict) -> bool:
        t = s.get("target") or {}
        names_raw = element_names_by_step.get(s["id"], [])
        # Symbol-only names ("×", "☰") normalise to nothing: compare them verbatim.
        if not el:
            return bool(raw) and ((t.get("name") or "").strip() == raw or raw in names_raw)
        # Page-level issues name the page itself.
        if el in (normalize(s["pagePath"]), normalize(s.get("title") or ""), "page"):
            return True
        target = normalize(t.get("name") or "")
        if target and (el in target or target in el):
            return True
        if t.get("selector") and el in normalize(t["selector"]):
            return True
        names = [normalize(n) for n in names_raw]
        if any(n and (el in n or n in el) for n in names):
            return True
        # An element can be named by what it looks like ("unlabeled search icon") when it has no name; accept if
        # the key words appear in the think-aloud or among the step's element names.
        words = [w for w in el.split(" ") if len(w) > 3]
        hay = f"{normalize(s['thinkAloud'])} {' '.join(names)} {target}"
        return bool(words) and sum(1 for w in words if w in hay) >= math.ceil(len(words) / 2)

    if not any(seen(s) for s in cited):
        reasons.append(f'element "{c.element}" does not appear in the cited steps')

    cited_ids = {s["id"] for s in cited}
    sigs = [s for s in signals if s["stepId"] in cited_ids]
    verified = []
    for q in c.quotes:
        nq = normalize(q)
        if len(nq) < 4:
            continue
        src = next((s for s in cited if nq in normalize(s["thinkAloud"]) or (len(nq) > 20 and _overlap(normalize(s["thinkAloud"]), nq) > 0.8)), None)
        if src:
            verified.append({"text": q, "stepId": src["id"]})
    if not sigs and not verified:
        reasons.append("no signal or verbatim quote behind it")
    types: list[str] = []
    for s in sigs:
        if s["type"] not in types:
            types.append(s["type"])
    return {"ok": not reasons, "reasons": reasons, "verifiedQuotes": verified, "signalTypes": types}
