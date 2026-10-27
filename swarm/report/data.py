"""Report data model: everything the HTML report and the JSON export show, computed from the evidence store. The
JSON is what CI consumes; the HTML renders the same object."""
from __future__ import annotations

import dataclasses
from datetime import datetime, timezone
from typing import Optional

from ..config import config
from ..store.db import Db
from ..util import median, page_path
from .diff import diff_issues

IMPACT_ORDER = ["critical", "serious", "moderate", "minor"]


def _outcome(s: dict) -> str:
    return s["outcome"] or s["status"]


def build_report_data(db: Db, study_id: str, compare_to: Optional[str] = None) -> dict:
    study = db.study(study_id)
    if not study:
        raise ValueError(f"no study {study_id}")
    tasks = db.tasks(study_id)
    personas = db.personas(study_id)
    sessions = db.sessions(study_id)
    issues = db.issues(study_id)
    analysable = [s for s in sessions if _outcome(s) != "infra_error" and s["status"] not in ("queued", "provisioning", "running")]
    steps = {s["id"]: db.steps(s["id"]) for s in sessions}

    matrix = []
    for t in tasks:
        for p in personas:
            ss = [s for s in analysable if s["taskId"] == t.id and s["personaId"] == p.id]
            ok = [s for s in ss if _outcome(s) == "succeeded"]
            matrix.append({"taskId": t.id, "personaId": p.id, "sessions": len(ss), "succeeded": len(ok),
                           "successRate": len(ok) / len(ss) if ss else None, "medianSteps": median([s["stepCount"] for s in ss]),
                           "medianHumanSec": round(median([s["estHumanMs"] for s in ss]) / 1000)})

    task_summaries = []
    for t in tasks:
        ss = [s for s in analysable if s["taskId"] == t.id]
        ok = [s for s in ss if _outcome(s) == "succeeded"]
        task_summaries.append({"id": t.id, "goal": t.goal, "sessions": len(ss), "successRate": len(ok) / len(ss) if ss else None,
                               "medianHumanSec": round(median([s["estHumanMs"] for s in ok]) / 1000)})

    funnels = [_funnel(t.id, [s for s in analysable if s["taskId"] == t.id], steps) for t in tasks]

    # Accessibility appendix: axe-core violations by page, counted once per page across sessions.
    by_page: dict[str, dict[str, dict]] = {}
    for a in db.audits(study_id):
        m = by_page.setdefault(a["pagePath"], {})
        for v in a["violations"]:
            e = m.setdefault(v["id"], {"id": v["id"], "impact": v.get("impact"), "help": v["help"], "helpUrl": v["helpUrl"], "nodes": 0, "sessions": set()})
            e["nodes"] = max(e["nodes"], len(v["nodes"]))
            e["sessions"].add(a["sessionId"])
    rank = lambda i: IMPACT_ORDER.index(i or "minor") if (i or "minor") in IMPACT_ORDER else -1  # noqa: E731
    accessibility = sorted(
        ({"page": page, "violations": sorted(({**v, "sessions": len(v["sessions"])} for v in m.values()), key=lambda v: rank(v["impact"]))}
         for page, m in by_page.items()), key=lambda x: x["page"])

    names = {p.id: p.name for p in personas}
    at_ids = {p.id for p in personas if p.accessibility.screen_reader or p.accessibility.keyboard_only}
    assistive = [{"personaId": s["personaId"], "name": names[s["personaId"]], "outcome": _outcome(s), "detail": s["outcomeDetail"]}
                 for s in analysable if s["personaId"] in at_ids]

    # Only the steps the report cites (issue evidence + quotes) are embedded.
    cited = {sid for i in issues for sid in i["evidenceStepIds"] + [q["stepId"] for q in i["quotes"]]}
    steps_by_id = {st["id"]: st for ss in steps.values() for st in ss if st["id"] in cited}

    diff = None
    base_id = compare_to or study["spec"].get("compare_to")
    if base_id and db.study(base_id):
        d = diff_issues(db.issues(base_id), issues)
        diff = {"comparedTo": base_id, "rows": d["rows"], "counts": d["counts"]}

    return {
        "generatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "study": {k: study[k] for k in ("id", "name", "targetUrl", "buildId", "status", "costUsd", "createdAt")},
        "models": dataclasses.asdict(config.models),
        "modelMode": config.model_mode,
        "coverage": {
            "sessions": len(sessions), "analysable": len(analysable), "infraErrors": sum(1 for s in sessions if _outcome(s) == "infra_error"),
            "personas": len(personas), "tasks": len(tasks), "repetitions": study["spec"]["budget"]["repetitions"],
            "steps": sum(len(s) for s in steps.values()), "tokens": sum(s["tokens"] for s in sessions),
        },
        "tasks": task_summaries,
        "personas": [p.model_dump(mode="json", exclude_none=True) for p in personas],
        "matrix": matrix, "funnels": funnels, "issues": issues, "accessibility": accessibility, "assistiveTech": assistive,
        "sessions": [{**s, "personaName": names.get(s["personaId"], s["personaId"])} for s in sessions],
        "stepsById": steps_by_id, "diff": diff,
    }


def _funnel(task_id: str, sessions: list[dict], steps: dict[str, list[dict]]) -> dict:
    """Drop-off per task: pages ordered by when sessions first reach them; a stage counts sessions that got at least
    that far. Successful sessions define the path; the funnel shows where everyone else leaked."""
    paths = []
    for s in sessions:
        seq: list[str] = []
        for st in steps.get(s["id"], []):
            if st["pagePath"] not in seq:
                seq.append(st["pagePath"])
        ss = steps.get(s["id"], [])
        last = ss[-1]["observation"].get("urlAfter") if ss else None
        if last and page_path(last) not in seq:
            seq.append(page_path(last))
        paths.append((s, seq))
    succeeded = [p for p in paths if _outcome(p[0]) == "succeeded"]
    basis = succeeded or paths
    first_seen: dict[str, list[int]] = {}
    for _, seq in basis:
        for i, page in enumerate(seq):
            first_seen.setdefault(page, []).append(i)
    min_share = max(1, -(-len(basis) // 2))
    order = [page for page, idx in sorted(((pg, ix) for pg, ix in first_seen.items() if len(ix) >= min_share), key=lambda kv: sum(kv[1]) / len(kv[1]))]
    stages = [{"page": page, "reached": sum(1 for _, seq in paths if any(p in seq for p in order[i:]))} for i, page in enumerate(order)]
    return {"taskId": task_id, "total": len(sessions), "stages": stages}
