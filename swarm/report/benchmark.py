"""Seeded-defect benchmark scorer: recall = seeded defects found / defects enabled in the run; precision = issues
that match a seeded defect / all issues reported. Track both on every model or prompt change."""
from __future__ import annotations

from typing import Optional

from pydantic import BaseModel

from demo_shop.defects import DEFECTS

from ..analysis.cluster import normalize
from ..config import config
from ..llm.client import structured, text_block
from ..store.db import Db


def match_defect(issue: dict) -> Optional[str]:
    """An issue counts as a seeded defect only if it names one of the defect's must-words AND either sits on the
    defect's page or hits another of its keywords. Strict on purpose: precision should not be flattered."""
    hay = normalize(f"{issue['title']} {issue['description']} {issue['element']}")
    page = normalize(issue["page"])
    best = None
    for d in DEFECTS:
        if not any(normalize(k) in hay for k in d["must"]):
            continue
        hits = sum(1 for k in d["keywords"] if normalize(k) in hay)
        page_match = page == normalize(d["page"]) or (":id" in d["page"] and page == normalize(d["page"].replace(":id", "id")))
        if not (page_match or hits >= 2):
            continue
        score = hits + (2 if page_match else 0)
        if best is None or score > best[1]:
            best = (d["id"], score)
    return best[0] if best else None


class JudgeMatch(BaseModel):
    issue: int
    defect: Optional[str]
    why: str


class JudgeOutput(BaseModel):
    matches: list[JudgeMatch]


JUDGE = ("You score a usability-testing tool against a list of known, deliberately seeded defects. For each reported issue, give the id of the seeded "
         "defect it describes, or null. Match only when the issue is about the same root cause on the same part of the site. An issue that mentions a "
         "defect's page or words but describes a different problem is null. Several issues may match the same defect.")


async def _judge_matches(issues: list[dict]) -> tuple[list[Optional[str]], float]:
    """A judge model maps each issue to the seeded defect it describes. Strict: same root cause and same place."""
    defects = "\n".join(f"{d['id']} [{d['page']}] {d['title']}. What users experience: {d['symptom']}" for d in DEFECTS)
    listing = "\n".join(f"{n}. [{i['page']}] {i['title']} — {i['description']} (element: {i['element']})" for n, i in enumerate(issues))
    value, usage = await structured(model=config.models.benchmark, schema=JudgeOutput, system=JUDGE, effort="medium", name="benchmark_matches",
                                    content=[text_block(f"Seeded defects:\n{defects}\n\nReported issues:\n{listing}\n\nReturn one entry per issue index.")])
    ids = {d["id"] for d in DEFECTS}
    out: list[Optional[str]] = [None] * len(issues)
    for m in value.matches:
        if 0 <= m.issue < len(issues):
            out[m.issue] = m.defect if m.defect in ids else None
    return out, usage["costUsd"]


async def score_benchmark(db: Db, study_id: str, enabled: Optional[list[str]] = None, method: str = "auto") -> dict:
    enabled = enabled or [d["id"] for d in DEFECTS]
    issues = db.issues(study_id)
    use_llm = method == "llm" or (method == "auto" and config.model_mode == "live")
    cost = 0.0
    if use_llm and issues:
        defects, cost = await _judge_matches(issues)
    else:
        defects = [match_defect(i) for i in issues]
    matches = [{"issue": i["title"], "severity": i["severity"], "defect": defects[n]} for n, i in enumerate(issues)]
    found = {m["defect"] for m in matches if m["defect"] and m["defect"] in enabled}
    true_pos = sum(1 for m in matches if m["defect"])
    return {
        "studyId": study_id,
        "method": f"llm-judge ({config.models.benchmark}, ${cost:.4f})" if use_llm else "keyword",
        "defectsEnabled": len(enabled), "defectsFound": sorted(found), "defectsMissed": [d for d in enabled if d not in found],
        "recall": round(len(found) / len(enabled), 3) if enabled else None,
        "precision": round(true_pos / len(issues), 3) if issues else None,
        "issues": matches,
    }
