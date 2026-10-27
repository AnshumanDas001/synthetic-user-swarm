"""Pass 2: LLM critic, one call per session. Reads think-aloud, signals and key screenshots, proposes candidate
issues, and every candidate goes through the evidence validator before it is kept."""
from __future__ import annotations

import json
from typing import Optional

from pydantic import BaseModel

from ..config import config
from ..llm.client import SchemaError, image_block, is_fatal, structured, text_block
from ..llm.prompts import CRITIC_SYSTEM
from ..models import CandidateDraft, Heuristic, Impact, PersonaCard, TaskSpec
from ..store.blobs import BlobStore
from ..util import log, new_id
from .embed import embed_text
from .validator import validate_candidate


class CriticIssue(BaseModel):
    title: str
    description: str
    page: str
    element: str
    heuristic: Heuristic
    impact: Impact
    step_ids: list[str]
    quotes: list[str]
    suggested_fix: str


class CriticOutput(BaseModel):
    issues: list[CriticIssue]


def _js(v) -> str:
    return json.dumps(v, separators=(",", ":"), ensure_ascii=False)


async def critique_session(*, session_id: str, study_id: str, repetition: int, card: PersonaCard, task: TaskSpec, outcome: dict,
                           steps: list[dict], signals: list[dict], blobs: BlobStore, use_llm: bool = True) -> dict:
    """Returns {accepted: [candidate], rejected: [{draft, reasons}], usage}. use_llm is False once the study's
    budget is spent: the free rule-based critic runs instead."""
    element_names: dict[str, list[str]] = {}
    for s in steps:
        try:
            els = json.loads(blobs.get(s["artifacts"]["elements"]))
            texts = [b["text"] for b in json.loads(blobs.get(s["artifacts"]["text"]))] if blobs.exists(s["artifacts"].get("text")) else []
            # Controls and visible text both count as "seen in the step" (copy and jargon issues cite text).
            element_names[s["id"]] = [e["name"] for e in els if e.get("name")] + texts
        except Exception:
            element_names[s["id"]] = []

    usage = None
    if config.model_mode == "mock" or not steps or not use_llm:
        drafts = rule_based_critic(outcome, steps, signals)
    else:
        try:
            drafts, usage = await _llm_critic(card, task, outcome, steps, signals, blobs)
        except Exception as e:
            # A failed critic call must not lose the session: fall back to the signal-based critic.
            if is_fatal(e):
                raise
            log("critic", f"{session_id}: LLM critic failed ({str(e)[:120]}); using rule-based critic")
            if isinstance(e, SchemaError):
                usage = e.usage
            drafts = rule_based_critic(outcome, steps, signals)

    accepted, rejected = [], []
    for draft in drafts:
        v = validate_candidate(draft, steps, signals, element_names)
        if not v["ok"]:
            rejected.append({"draft": draft.model_dump(), "reasons": v["reasons"]})
            continue
        d = draft.model_dump(exclude_none=True)
        accepted.append({
            **d,
            # Keep only quotes that are actually in the record.
            "quotes": [q["text"] for q in v["verifiedQuotes"]],
            "id": new_id("cand"), "sessionId": session_id, "personaId": card.id, "taskId": task.id, "repetition": repetition,
            "signalTypes": v["signalTypes"], "quoteRefs": v["verifiedQuotes"],
            "embedding": embed_text(f"{draft.title} {draft.description} {draft.page} {draft.element}"),
        })
    return {"accepted": accepted, "rejected": rejected, "usage": usage}


async def _llm_critic(card: PersonaCard, task: TaskSpec, outcome: dict, steps: list[dict], signals: list[dict], blobs: BlobStore):
    sig_by_step: dict[str, list[dict]] = {}
    for s in signals:
        sig_by_step.setdefault(s["stepId"], []).append(s)

    lines = []
    for s in steps:
        o = s["observation"]
        t = s.get("target")
        sig = [f"{x['type']}{' ' + _js(x['details']) if x['details'] else ''}" for x in sig_by_step.get(s["id"], [])]
        met = o.get("expectationMet")
        observed = (f"  observed: navigated={_b(o.get('navigated'))}"
                    + (f" targetMovedBeforeTap={o['targetMoved']['dy']}px" if o.get("targetMoved") else "")
                    + f" domChanged={_b(o.get('domChanged'))} network={o.get('networkCalls', 0)}"
                    + (f" slowRequest={o['slowRequest']['ms']}ms progressShown={_b(o['slowRequest']['domChangedWhileWaiting'])}" if o.get("slowRequest") else "")
                    + (f" loadShift={o['loadShift']}" if o.get("loadShift") else "")
                    + (f" messages={_js(o['validationMessages'])}" if o.get("validationMessages") else "")
                    + (f' error="{o["actionError"]}"' if o.get("actionError") else "")
                    + (" tap-hit-overlay" if o.get("targetCovered") else ""))
        parts = [
            f'step_id={s["id"]} #{s["idx"]} page={s["pagePath"]} title="{s["title"]}"',
            f'  think-aloud: "{s["thinkAloud"]}" (confidence {s["confidence"]}/5, frustration {s["frustration"]}/10)',
            f'  action: {_js(s["action"])}' + (f' on {t["role"]} "{t["name"] or "(no accessible name)"}" [{t["selector"]}]' if t else ""),
            f'  expected: "{s["expectation"]["says"]}" -> {"not testable" if met is None else "met" if met else "NOT met"}',
            observed,
        ]
        if sig:
            parts.append(f"  signals: {'; '.join(sig)}")
        lines.append("\n".join(parts))

    # Key screenshots: steps where signals fired, plus the last step. At most 5 images.
    key_ids = list(dict.fromkeys([s["stepId"] for s in signals] + [steps[-1]["id"]]))
    by_id = {s["id"]: s for s in steps}
    key_steps = [by_id[i] for i in key_ids if i in by_id and (by_id[i]["artifacts"].get("before_marked") or by_id[i]["artifacts"].get("before"))][-5:]
    images = []
    for s in key_steps:
        images += [text_block(f"Screenshot for step_id={s['id']} (#{s['idx']}, {s['pagePath']}):"),
                   image_block(blobs.get(s["artifacts"].get("before_marked") or s["artifacts"]["before"]))]

    c = card
    a = c.accessibility
    header = (f"Persona: {c.name}, {c.archetype}. Device {c.device.viewport}{' touch' if c.device.touch else ''}, literacy {c.digital_literacy}/5, reading {c.reading}"
              f"{', screen reader' if a.screen_reader else ''}{', keyboard only' if a.keyboard_only else ''}{f', zoom {a.zoom:g}%' if a.zoom > 100 else ''}."
              f"\nTask: {task.goal}\nOutcome: {outcome['status']}{' (' + outcome['detail'] + ')' if outcome.get('detail') else ''}")
    value, usage = await structured(model=config.models.critic, schema=CriticOutput, system=CRITIC_SYSTEM,
                                    content=[text_block(f"{header}\n\nSteps:\n" + "\n".join(lines)), *images, text_block("Propose the candidate issues for this session.")],
                                    effort=config.effort.critic, max_tokens=12000, name="candidate_issues")
    drafts = []
    for i in value.issues:
        try:
            drafts.append(CandidateDraft.model_validate(i.model_dump()))
        except Exception:
            pass  # e.g. no step ids: the validator would reject it anyway
    return drafts, usage


def _b(v) -> str:
    return "true" if v else "false"


def rule_based_critic(outcome: dict, steps: list[dict], signals: list[dict]) -> list[CandidateDraft]:
    """Offline critic: turns deterministic signals into candidates with the agent's own words as quotes."""
    failed = outcome["status"] != "succeeded"
    last_idx = steps[-1]["idx"] if steps else 0
    by_key: dict[str, dict] = {}
    by_id = {s["id"]: s for s in steps}
    for sig in signals:
        step = by_id.get(sig["stepId"])
        if not step:
            continue
        t = step.get("target")
        el = (t or {}).get("name") or (f"unlabeled {t['role']}" if t else "page")
        d = sig["details"]
        pp = step["pagePath"]
        draft = None
        typ = sig["type"]
        if typ == "dead_click":
            draft = (f'"{el}" does nothing when pressed', f'Pressing "{el}" produced no visible change, navigation or request.', el, "visibility_of_system_status")
        elif typ == "layout":
            k = d.get("kind")
            if k == "covered":
                draft = (f'"{el}" is covered by another element', f'The tap on "{el}" landed on an overlay instead.', el, "aesthetic_and_minimalist_design")
            elif k == "moved_before_tap":
                draft = (f'Content moved just before tapping "{el}"', f'The page shifted {abs(float(d.get("dy") or 0)):g}px between seeing "{el}" and tapping it, so the tap landed elsewhere.', el, "consistency_and_standards")
            elif k == "load_shift":
                draft = (f"Content jumps after {pp} loads", f"Content that loaded more than a second late shifted the page (layout shift {d.get('cls')}), so anything a person was about to tap moved.", "page", "consistency_and_standards")
            elif k == "offscreen":
                draft = (f'"{el}" is off-screen at this viewport', f'The primary action "{el}" was not visible without scrolling.', el, "recognition_rather_than_recall")
            else:
                draft = (f"Content shifts under the user on {pp}", f"Layout shift of {d.get('cls')} after the action.", el, "consistency_and_standards")
        elif typ == "search_miss":
            draft = ("Site search returns no results", "A plausible search query returned zero results.", el, "match_between_system_and_real_world")
        elif typ == "error_shown":
            v = d.get("validation") or []
            if v:
                draft = (f"Form error on {pp}: {v[0][:60]}", f"Validation message shown: {'; '.join(v)}", el, "help_users_recognize_diagnose_recover_from_errors")
        elif typ == "accessibility":
            k = d.get("kind")
            if k == "no_accessible_name":
                draft = (f"Control with no accessible name on {pp}", f"A {(t or {}).get('role') or 'control'} ({d.get('selector')}) has no accessible name.", el, "consistency_and_standards")
            elif k == "keyboard_trap":
                draft = (f"Keyboard focus is trapped on {pp}", "Tab cycles inside a small set of elements and cannot leave it.", "focus trap", "user_control_and_freedom")
            elif k == "not_keyboard_operable":
                draft = (f'"{el}" cannot be operated from the keyboard', str(d.get("error")), el, "flexibility_and_efficiency_of_use")
        elif typ == "slow_response":
            prog = d.get("progressShown")
            draft = (f'"{el}" is slow to respond{"" if prog else " with no progress indicator"}',
                     f'{d.get("request")} took {float(d.get("ms") or 0) / 1000:.1f} s after pressing "{el}"{"" if prog else ", and nothing on screen showed it was working"}.',
                     el, "visibility_of_system_status")
        elif typ == "rage_click":
            draft = (f'Repeated presses on "{el}"', f'The user pressed "{el}" {d.get("count")} times in a row.', el, "visibility_of_system_status")
        elif typ in ("give_up", "task_failed"):
            draft = (f"Task abandoned on {pp}", f"Session ended {outcome['status']}: {outcome.get('detail') or ''}", el, "user_control_and_freedom")
        if not draft:
            continue
        title, desc, element, heuristic = draft
        key = f"{pp}|{title}"
        if key in by_key:
            if step["id"] not in by_key[key]["step_ids"]:
                by_key[key]["step_ids"].append(step["id"])
            continue
        terminal = typ in ("give_up", "task_failed")
        at_the_end = failed and step["idx"] == last_idx and typ in ("dead_click", "layout", "error_shown", "accessibility")
        impact = "blocked" if terminal or at_the_end else "major_detour" if typ in ("layout", "dead_click") else "minor_friction"
        by_key[key] = {"title": title, "description": desc, "element": element, "heuristic": heuristic, "page": pp, "impact": impact,
                       "step_ids": [step["id"]], "quotes": [step["thinkAloud"]] if step["thinkAloud"] else []}
    return [CandidateDraft.model_validate(v) for v in by_key.values()]
