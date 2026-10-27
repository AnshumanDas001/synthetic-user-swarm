"""Run diff: compare two studies on the same tasks and label each issue new, fixed, regressed or unchanged. Issues
match on their fingerprint (page + element + heuristic) or, failing that, on text similarity."""
from __future__ import annotations

from typing import Optional

from ..analysis.cluster import normalize
from ..analysis.embed import cosine, embed_text
from ..store.db import Db

ORDER = ["regressed", "new", "unchanged", "fixed"]


def match_issues(base: list[dict], head: list[dict]) -> dict[str, str]:
    """head id -> base id"""
    pairs: dict[str, str] = {}
    used: set[str] = set()
    for h in head:
        exact = next((b for b in base if b["id"] not in used and b["fingerprint"] == h["fingerprint"]), None)
        if exact:
            pairs[h["id"]] = exact["id"]
            used.add(exact["id"])

    def vec(i: dict) -> list[float]:
        return embed_text(f"{i['title']} {i['description']} {i['page']} {i['element']}")

    for h in head:
        if h["id"] in pairs:
            continue
        hv = vec(h)
        best: Optional[tuple[str, float]] = None
        for b in base:
            if b["id"] in used:
                continue
            sim = cosine(hv, vec(b)) + (0.1 if normalize(b["page"]) == normalize(h["page"]) else 0)
            if sim > 0.62 and (best is None or sim > best[1]):
                best = (b["id"], sim)
        if best:
            pairs[h["id"]] = best[0]
            used.add(best[0])
    return pairs


def diff_issues(base: list[dict], head: list[dict]) -> dict:
    pairs = match_issues(base, head)
    matched_base = set(pairs.values())
    by_id = {b["id"]: b for b in base}
    rows = []
    for h in head:
        b = by_id.get(pairs.get(h["id"], ""))
        # Regressed: still present and noticeably worse (higher severity or wider reach).
        if not b:
            status = "new"
        elif h["severity"] >= b["severity"] + 0.5 or h["reach"]["sessions"] >= b["reach"]["sessions"] * 1.5 + 1:
            status = "regressed"
        else:
            status = "unchanged"
        rows.append({"status": status, "title": h["title"], "severity": h["severity"], "baseSeverity": b["severity"] if b else None,
                     "headIssueId": h["id"], "baseIssueId": b["id"] if b else None})
    for b in base:
        if b["id"] not in matched_base:
            rows.append({"status": "fixed", "title": b["title"], "severity": 0, "baseSeverity": b["severity"], "headIssueId": None, "baseIssueId": b["id"]})
    rows.sort(key=lambda r: (ORDER.index(r["status"]), -r["severity"]))
    counts = {"new": 0, "fixed": 0, "regressed": 0, "unchanged": 0}
    for r in rows:
        counts[r["status"]] += 1
    return {"rows": rows, "counts": counts}


def diff_studies(db: Db, base_study_id: str, head_study_id: str) -> dict:
    return diff_issues(db.issues(base_study_id), db.issues(head_study_id))
