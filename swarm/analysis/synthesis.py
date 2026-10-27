"""Pass 3: cross-session synthesis. Cluster candidates, let an LLM merge clusters that share a root cause, then
compute reach, severity and confidence and pick the strongest evidence for each card."""
from __future__ import annotations

from collections import Counter
from typing import Any, Optional

from pydantic import BaseModel

from ..config import config
from ..llm.client import structured, text_block
from ..llm.prompts import MERGE_SYSTEM
from ..models import IMPACT_SCORE, PersonaCard
from ..personas.profiles import is_mobile
from ..util import sha256
from .cluster import agglomerative, normalize
from .severity import confidence, reach_label, severity


class MergedIssue(BaseModel):
    cluster_ids: list[str]
    title: str
    description: str
    suggested_fix: str


class MergeOutput(BaseModel):
    issues: list[MergedIssue]


# Signal priority when picking which steps make the issue card.
SIGNAL_RANK = ["layout", "slow_response", "dead_click", "rage_click", "expectation_mismatch", "error_shown", "accessibility",
               "search_miss", "give_up", "task_failed", "loop", "stall", "backtrack", "scroll_hunt"]


def _mode(xs: list) -> Any:
    return Counter(xs).most_common(1)[0][0]


async def synthesize(*, study_id: str, candidates: list[dict], sessions: list[dict], steps_by_session: dict[str, list[dict]],
                     signals_by_session: dict[str, list[dict]], personas: list[PersonaCard], use_llm_merge: bool) -> tuple[list[dict], Optional[dict]]:
    if not candidates:
        return [], None
    clusters = agglomerative(candidates)
    groups: list[dict] = [{"members": c} for c in clusters]
    usage = None

    if use_llm_merge and config.model_mode == "live" and len(clusters) > 1:
        labelled = [{"id": f"c{i + 1}", "members": c} for i, c in enumerate(clusters)]
        listing = "\n".join(
            f'{c["id"]}: page={_mode([m["page"] for m in c["members"]])} element="{_mode([m["element"] for m in c["members"]])}" n={len(c["members"])}\n'
            f'  titles: ' + "; ".join(f'"{t}"' for t in list(dict.fromkeys(m["title"] for m in c["members"]))[:6])
            for c in labelled)
        try:
            value, usage = await structured(model=config.models.synthesis, schema=MergeOutput, system=MERGE_SYSTEM,
                                            content=[text_block(f"Clusters:\n{listing}\n\nReturn every cluster id exactly once across the issues.")],
                                            effort="medium", max_tokens=12000, name="merged_issues")
            used: set[str] = set()
            merged = []
            by_label = {c["id"]: c["members"] for c in labelled}
            for iss in value.issues:
                members = []
                for cid in iss.cluster_ids:
                    if cid in used:
                        continue
                    used.add(cid)
                    members += by_label.get(cid, [])
                if members:
                    merged.append({"members": members, "title": iss.title, "description": iss.description, "fix": iss.suggested_fix})
            # Any cluster the model forgot stays as its own issue.
            merged += [{"members": c["members"]} for c in labelled if c["id"] not in used]
            groups = merged
        except Exception:
            pass  # the merge pass is an improvement, not a dependency: keep the raw clusters

    session_by_id = {s["id"]: s for s in sessions}
    persona_by_id = {p.id: p for p in personas}
    analysable = [s for s in sessions if s["status"] not in ("queued", "provisioning", "running", "infra_error")]
    issues = [_build_issue(g, study_id, steps_by_session, signals_by_session, session_by_id, persona_by_id, analysable) for g in groups]
    issues.sort(key=lambda i: (-i["severity"], -i["reach"]["sessions"]))
    return issues, usage


def _build_issue(g: dict, study_id: str, steps_by_session: dict, signals_by_session: dict, session_by_id: dict,
                 persona_by_id: dict, analysable: list[dict]) -> dict:
    m = g["members"]
    page = _mode([c["page"] for c in m])
    element = _mode([c["element"] for c in m])
    sessions = list(dict.fromkeys(c["sessionId"] for c in m))
    persona_ids = list(dict.fromkeys(c["personaId"] for c in m))
    repetitions = {c["repetition"] for c in m}
    task_ids = list(dict.fromkeys(c["taskId"] for c in m))

    # Sessions that reached the page (any task in this issue). Late-funnel issues are not underrated.
    reached = [s for s in analysable if s["taskId"] in task_ids
               and any(st["pagePath"] == page or normalize(st["pagePath"]) == normalize(page) for st in steps_by_session.get(s["id"], []))]
    reached_n = max(len(reached), len(sessions))

    impact = _resolve_impact(m, session_by_id)
    signal_types = list(dict.fromkeys(t for c in m for t in c.get("signalTypes", [])))
    passed_elsewhere = len(persona_ids) == 1 and any(
        s["personaId"] == persona_ids[0] and s["taskId"] in task_ids and s["outcome"] == "succeeded" and s["id"] not in sessions for s in analysable)
    conf = confidence(signal_types, len(persona_ids), len(sessions), len(repetitions), passed_elsewhere)

    # Segment label for the reach line: "5 of 6 mobile sessions" when every hit is mobile.
    cards = [persona_by_id[p] for p in persona_ids if p in persona_by_id]
    all_mobile = bool(cards) and all(is_mobile(c) for c in cards)
    seg_reached = sum(1 for s in reached if s["personaId"] in persona_by_id and is_mobile(persona_by_id[s["personaId"]])) if all_mobile else reached_n

    seen_q: set[str] = set()
    quotes = []
    for q in (q for c in m for q in c.get("quoteRefs", [])):
        k = normalize(q["text"])
        if k not in seen_q:
            seen_q.add(k)
            quotes.append(q)
    base = m[0]
    for c in m:
        if IMPACT_SCORE[c["impact"]] > IMPACT_SCORE[base["impact"]]:
            base = c
    heuristic = _mode([c["heuristic"] for c in m])
    issue = {
        "id": "iss_" + sha256(",".join(sorted(c["id"] for c in m)))[:10],
        "studyId": study_id, "taskIds": task_ids,
        "title": g.get("title") or base["title"], "description": g.get("description") or base["description"],
        "page": page, "element": element, "heuristic": heuristic, "impact": impact,
        "severity": severity(impact, len(sessions), reached_n), "confidence": conf["level"], "needsReview": conf["needsReview"],
        "reach": {"sessions": len(sessions), "sessionsReachedPage": reached_n, "personas": len(persona_ids), "repetitions": len(repetitions),
                  "label": reach_label(len(sessions), max(seg_reached, len(sessions)) if all_mobile else reached_n, len(persona_ids), "mobile" if all_mobile else None)},
        "personaIds": persona_ids, "candidateIds": [c["id"] for c in m],
        "evidenceStepIds": _pick_evidence(m, signals_by_session), "quotes": quotes[:2], "signalTypes": signal_types,
        "status": "open", "fingerprint": fingerprint(page, element, heuristic),
    }
    fix = g.get("fix") or next((c["suggested_fix"] for c in m if c.get("suggested_fix")), None)
    if fix:
        issue["suggestedFix"] = fix
    return issue


def _resolve_impact(m: list[dict], session_by_id: dict) -> str:
    valid = []
    for c in m:
        if c["impact"] != "blocked":
            valid.append(c["impact"])
        else:
            s = session_by_id.get(c["sessionId"])
            valid.append("blocked" if s and s["outcome"] != "succeeded" else "major_detour")
    # Take the highest impact that at least a third of the members agree on.
    for level in ("blocked", "major_detour", "minor_friction", "cosmetic"):
        if sum(1 for v in valid if IMPACT_SCORE[v] >= IMPACT_SCORE[level]) / len(valid) >= 1 / 3:
            return level
    return "cosmetic"


def _pick_evidence(m: list[dict], signals_by_session: dict) -> list[str]:
    """The 3-5 strongest evidence steps: the clearest screenshot, the most telling quote, the signal that fired."""
    scored = []
    for c in m:
        sigs = signals_by_session.get(c["sessionId"], [])
        for sid in c["step_ids"]:
            ranks = [SIGNAL_RANK.index(s["type"]) for s in sigs if s["stepId"] == sid and s["type"] in SIGNAL_RANK]
            best = min(ranks + [99])
            quoted = any(q["stepId"] == sid for q in c.get("quoteRefs", []))
            scored.append({"id": sid, "sessionId": c["sessionId"], "score": (99 - best) + (20 if quoted else 0)})
    scored.sort(key=lambda x: -x["score"])
    # Prefer diversity across sessions.
    out: list[str] = []
    used: set[str] = set()
    for s in scored:
        if s["sessionId"] not in used and len(out) < 5:
            out.append(s["id"])
            used.add(s["sessionId"])
    for s in scored:
        if s["id"] not in out and len(out) < 3:
            out.append(s["id"])
    return out


def fingerprint(page: str, element: str, heuristic: str) -> str:
    return sha256(f"{normalize(page)}|{normalize(element)}|{heuristic}")[:12]
