"""Check stage: pure code, no LLM, which is why its signals can be trusted. Tests the agent's expectation
predicate, the task's success criteria, and estimates human time."""
from __future__ import annotations

import re
from typing import Optional

from playwright.async_api import Page

from ..models import PersonaCard, SuccessCriteria
from ..personas.profiles import reading_wpm

_BODY_TEXT = ('document.body ? document.body.innerText + "\\n" + Array.from(document.querySelectorAll("input:not([type=password]),textarea"))'
              '.map((e) => e.value).filter(Boolean).join("\\n") : ""')


async def snapshot(page: Page, marks: list[int], dialog_open: bool, focused: Optional[str]) -> dict:
    """Visible text plus what is typed into fields (innerText leaves out input values)."""
    try:
        body = await page.evaluate(_BODY_TEXT)
    except Exception:
        body = ""
    marked = {}
    for m in marks:
        try:
            marked[m] = await page.evaluate(f"window.__sus && window.__sus.elementState({m})")
        except Exception:
            marked[m] = None
    return {"url": page.url, "bodyText": body or "", "dialogOpen": dialog_open, "focused": focused, "marked": marked}


def marks_for(check: dict) -> list[int]:
    return [check["mark"]] if check["type"] in ("text_changes", "element_changes") else []


def expectation_met(check: dict, before: dict, after: dict) -> Optional[bool]:
    """None when the agent made no testable prediction."""
    t = check["type"]
    if t == "none":
        return None
    if t == "url_changes":
        return before["url"].split("#")[0] != after["url"].split("#")[0]
    if t == "url_contains":
        return check["value"].lower() in after["url"].lower()
    if t == "text_appears":
        needle = check["value"].lower().strip()
        return needle in after["bodyText"].lower() and (needle not in before["bodyText"].lower() or before["url"] != after["url"])
    if t == "text_changes":
        b, a = before["marked"].get(check["mark"]), after["marked"].get(check["mark"])
        return bool(b) and (not a or a.get("text") != b.get("text"))
    if t == "element_changes":
        b, a = before["marked"].get(check["mark"]), after["marked"].get(check["mark"])
        return bool(b) and (not a or a.get("html") != b.get("html") or a.get("value") != b.get("value"))
    if t == "dialog_opens":
        return not before["dialogOpen"] and after["dialogOpen"]
    if t == "focus_moves":
        return before["focused"] != after["focused"]
    return None


def check_success(criteria: SuccessCriteria, url: str, body_text: str, network: list[dict], judge: Optional[dict] = None) -> dict:
    """Success is never taken on the agent's word: it is tested against the task's criteria."""
    checks = []
    if criteria.url_pattern:
        checks.append({"kind": "url_pattern", "passed": bool(re.search(criteria.url_pattern, url, re.I)), "detail": f"{url} ~ /{criteria.url_pattern}/"})
    if criteria.text_present:
        checks.append({"kind": "text_present", "passed": criteria.text_present.lower() in body_text.lower(), "detail": f'"{criteria.text_present}"'})
    if criteria.network:
        n = criteria.network
        rx = re.compile(n.url_pattern, re.I)
        hit = any(e["method"].upper() == n.method.upper() and rx.search(e["url"]) and (n.status is None or e["status"] == n.status) for e in network)
        checks.append({"kind": "network", "passed": hit, "detail": f"{n.method} {n.url_pattern} {n.status if n.status is not None else ''}".strip()})
    if criteria.llm_judge and judge:
        checks.append({"kind": "llm_judge", "passed": judge["passed"], "detail": judge["detail"]})
    if not checks:
        return {"success": False, "checks": checks}
    ok = all(c["passed"] for c in checks) if criteria.mode == "all" else any(c["passed"] for c in checks)
    return {"success": ok, "checks": checks}


# Operator times in ms (Card, Moran & Newell): K keystroke, P point, B button, H home, M mental prep.
KLM = {"K": 280, "P": 1100, "B": 100, "H": 400, "M": 1350, "tap": 700}


def estimate_human_ms(card: PersonaCard, action: dict, words_seen: int, chars_typed: int) -> int:
    read_ms = (words_seen / reading_wpm(card)) * 60_000
    # Lower literacy means slower typing and more hesitation before acting.
    literacy = 1 + (3 - card.digital_literacy) * 0.15
    t = action["type"]
    act_ms = {
        "click": KLM["P"] + KLM["B"],
        "tap": KLM["tap"],
        "type": KLM["P"] + KLM["B"] + KLM["H"] + chars_typed * KLM["K"] * (1.6 if card.device.touch else 1),
        "select": 2 * (KLM["P"] + KLM["B"]),
        "scroll": 800,
        "press": KLM["K"] * (action.get("times") or 1),
        "hover": KLM["P"],
        "back": KLM["P"] + KLM["B"],
        "wait": float(action.get("seconds") or 0) * 1000,
    }.get(t, 0)
    return round(read_ms + (KLM["M"] + act_ms) * literacy)
