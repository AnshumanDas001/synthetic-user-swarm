"""Analysis in three passes: deterministic signals -> LLM critic per session -> cross-session synthesis."""
from __future__ import annotations

from typing import Optional

from ..store.blobs import BlobStore
from ..store.db import Db
from ..store.events import EventBus
from ..util import log
from .critic import critique_session
from .signals import detect_signals
from .synthesis import synthesize


async def analyse_session(db: Db, blobs: BlobStore, session_id: str) -> dict:
    s = db.session(session_id)
    if not s:
        raise ValueError(f"no session {session_id}")
    steps = db.steps(session_id)
    outcome = {"status": s["outcome"] or s["status"], "detail": s["outcomeDetail"]}

    # Pass 1
    signals = detect_signals(steps, outcome)
    db.replace_signals(session_id, signals)

    # Infra errors never count as usability findings.
    if outcome["status"] == "infra_error":
        db.replace_candidates(session_id, s["studyId"], [])
        return {"accepted": 0, "rejected": 0, "costUsd": 0}

    # Pass 2
    card = next(p for p in db.personas(s["studyId"]) if p.id == s["personaId"])
    task = next(t for t in db.tasks(s["studyId"]) if t.id == s["taskId"])
    study = db.study(s["studyId"])
    use_llm = study["costUsd"] < study["spec"]["budget"]["cost_cap_usd"]
    res = await critique_session(session_id=session_id, study_id=s["studyId"], repetition=s["repetition"], card=card, task=task,
                                 outcome=outcome, steps=steps, signals=signals, blobs=blobs, use_llm=use_llm)
    db.replace_candidates(session_id, s["studyId"], res["accepted"])
    if res["rejected"]:
        log("critic", f"{session_id}: rejected {len(res['rejected'])} candidate(s) without evidence: " + " | ".join(r["reasons"][0] for r in res["rejected"]))
    cost = (res["usage"] or {}).get("costUsd", 0) or 0
    if cost:
        db.add_study_cost(s["studyId"], cost)
    db.update_session(session_id, status="analysed")
    return {"accepted": len(res["accepted"]), "rejected": len(res["rejected"]), "costUsd": cost}


async def synthesize_study(db: Db, study_id: str, llm_merge: bool, bus: Optional[EventBus] = None) -> list[dict]:
    sessions = db.sessions(study_id)
    issues, usage = await synthesize(
        study_id=study_id, candidates=db.candidates(study_id), sessions=sessions,
        steps_by_session={s["id"]: db.steps(s["id"]) for s in sessions},
        signals_by_session={s["id"]: db.signals(s["id"]) for s in sessions},
        personas=db.personas(study_id), use_llm_merge=llm_merge)
    if usage:
        db.add_study_cost(study_id, usage["costUsd"])
    db.replace_issues(study_id, issues)
    if bus:
        bus.publish(study_id, "issues.updated", {"issues": [issue_summary(i) for i in issues]})
    return issues


def issue_summary(i: dict) -> dict:
    return {"id": i["id"], "title": i["title"], "page": i["page"], "severity": i["severity"], "confidence": i["confidence"],
            "reach": i["reach"]["label"], "sessions": i["reach"]["sessions"], "personas": i["personaIds"]}
