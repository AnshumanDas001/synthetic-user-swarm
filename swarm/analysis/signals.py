"""Pass 1: deterministic friction signals (per step, no LLM). Starting rules from the spec, tunable per site.
Pure function over recorded steps, so it runs live during a session and again at analysis time."""
from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass
from typing import Optional

from ..util import sha256


@dataclass(frozen=True)
class SignalRules:
    rage_click_run: int = 3       # consecutive activations of the same element/region
    loop_repeats: int = 3         # same page-state hash N times
    scroll_hunt: int = 4          # scrolls on one page without acting
    stall_steps: int = 5          # steps with no new page state
    layout_shift: float = 0.1     # CLS jump between steps
    keyboard_trap_tabs: int = 6   # Tab presses without focus leaving a small set
    slow_ms: int = 2000           # a request slower than this after an action
    load_shift: float = 0.02      # late layout shift (content arriving > 1 s after load) on arrival at a page


DEFAULT_RULES = SignalRules()
ACTIVATE = {"click", "tap"}
# Clicking into a field answers with focus, not a DOM change, so it can't be a dead click.
FIELD_ROLES = {"textbox", "searchbox", "combobox", "spinbutton", "slider"}


def _js(v) -> str:
    return json.dumps(v, separators=(",", ":"), ensure_ascii=False)


def _sig(step: dict, type: str, details: dict) -> dict:
    key = step["id"] + ":" + type + ":" + _js(details)
    return {"id": "sig_" + sha256(key)[:12], "stepId": step["id"], "sessionId": step["sessionId"], "type": type, "details": details}


def _tname(s: dict) -> Optional[str]:
    return (s.get("target") or {}).get("name")


def _same_target(a: dict, b: dict) -> bool:
    ta, tb = a.get("target"), b.get("target")
    if not ta or not tb:
        return False
    if ta["selector"] == tb["selector"] and ta["name"] == tb["name"]:
        return True
    ca = (ta["box"]["x"] + ta["box"]["width"] / 2, ta["box"]["y"] + ta["box"]["height"] / 2)
    cb = (tb["box"]["x"] + tb["box"]["width"] / 2, tb["box"]["y"] + tb["box"]["height"] / 2)
    return math.hypot(ca[0] - cb[0], ca[1] - cb[1]) < 30


def detect_signals(steps: list[dict], outcome: Optional[dict], rules: SignalRules = DEFAULT_RULES) -> list[dict]:
    out: list[dict] = []
    seen_states: dict[str, int] = {}
    rage_run, scroll_run, stall_run, tab_run, tab_steps = 1, 0, 0, 0, 0
    tab_focus: set[str] = set()

    for i, s in enumerate(steps):
        prev = steps[i - 1] if i > 0 else None
        o = s["observation"]
        a = s["action"]
        t = s.get("target")

        # Dead click: no DOM change, navigation or network call within ~1 s of the action.
        if a["type"] in ACTIVATE and not o.get("actionError") and not o.get("navigated") and not o.get("domChanged") \
                and o.get("networkCalls", 0) == 0 and (t or {}).get("role", "") not in FIELD_ROLES:
            out.append(_sig(s, "dead_click", {"element": _tname(s), "selector": (t or {}).get("selector")}))

        # Rage click: the same element or region activated N times in a row. Agent steps are not human-paced,
        # so consecutive steps stand in for the 2 s window.
        if prev and a["type"] in ACTIVATE and prev["action"]["type"] in ACTIVATE and _same_target(s, prev):
            rage_run += 1
            if rage_run == rules.rage_click_run:
                out.append(_sig(s, "rage_click", {"element": _tname(s), "count": rage_run}))
        else:
            rage_run = 1

        if o.get("expectationMet") is False:
            out.append(_sig(s, "expectation_mismatch", {"expected": s["expectation"]["says"], "check": s["expectation"]["check"]["type"]}))

        # Backtrack: explicit back, or returning to an earlier page state after leaving it.
        earlier = seen_states.get(s["stateHash"])
        if a["type"] == "back":
            out.append(_sig(s, "backtrack", {"via": "back"}))
        elif earlier is not None and prev and prev["stateHash"] != s["stateHash"] and i - earlier > 1 and s["pagePath"] != prev["pagePath"]:
            out.append(_sig(s, "backtrack", {"via": "returned", "toStep": earlier}))
        count = sum(1 for x in steps[: i + 1] if x["stateHash"] == s["stateHash"])
        if count == rules.loop_repeats:
            out.append(_sig(s, "loop", {"stateHash": s["stateHash"], "repeats": count}))
        if earlier is None:
            seen_states[s["stateHash"]] = i
            stall_run = 0
        else:
            stall_run += 1
            if stall_run == rules.stall_steps:
                out.append(_sig(s, "stall", {"steps": stall_run}))

        # Error shown: validation message, 4xx/5xx response, or console exception.
        prev_val = (prev["observation"].get("validationMessages") or []) if prev else []
        new_val = [m for m in o.get("validationMessages") or [] if m not in prev_val]
        http_errors = [n for n in o.get("networkErrors") or [] if n["status"] >= 400 or n["status"] == 0]
        if new_val or http_errors or o.get("consoleErrors"):
            out.append(_sig(s, "error_shown", {"validation": new_val, "http": http_errors[:5], "console": (o.get("consoleErrors") or [])[:3]}))

        if o.get("searchZeroResults") and (not prev or not prev["observation"].get("searchZeroResults")):
            out.append(_sig(s, "search_miss", {"url": s["url"]}))

        if a["type"] == "scroll" and (not prev or prev["pagePath"] == s["pagePath"]):
            scroll_run += 1
            if scroll_run == rules.scroll_hunt:
                out.append(_sig(s, "scroll_hunt", {"scrolls": scroll_run, "page": s["pagePath"]}))
        elif a["type"] != "scroll":
            scroll_run = 0

        # Layout: the primary action was covered by an overlay or off-screen at the persona's viewport,
        # or content shifted under the user.
        if o.get("targetCovered"):
            out.append(_sig(s, "layout", {"kind": "covered", "element": _tname(s)}))
        elif o.get("primaryActionOffscreen"):
            out.append(_sig(s, "layout", {"kind": "offscreen", "element": _tname(s)}))
        if (o.get("layoutShift") or 0) >= rules.layout_shift:
            out.append(_sig(s, "layout", {"kind": "layout_shift", "cls": round(o["layoutShift"], 3)}))
        if (o.get("loadShift") or 0) >= rules.load_shift:
            out.append(_sig(s, "layout", {"kind": "load_shift", "cls": o["loadShift"], "page": s["pagePath"]}))
        if o.get("targetMoved"):
            out.append(_sig(s, "layout", {"kind": "moved_before_tap", "element": _tname(s), "dx": o["targetMoved"]["dx"], "dy": o["targetMoved"]["dy"]}))

        # Slow response: the action's request took 2 s or more. Silent when nothing on screen changed meanwhile.
        sr = o.get("slowRequest")
        if sr and sr["ms"] >= rules.slow_ms:
            out.append(_sig(s, "slow_response", {"ms": sr["ms"], "request": f"{sr['method']} {re.sub(r'^https?://[^/]+', '', sr['url'])}",
                                                 "progressShown": sr["domChangedWhileWaiting"], "element": _tname(s)}))

        # Accessibility: keyboard trap (Tab keeps cycling a tiny set of elements) and unnamed controls used.
        if a["type"] == "press" and re.fullmatch(r"(shift\+)?tab", a.get("key", ""), re.I):
            tab_run += a.get("times") or 1
            tab_steps += 1
            tab_focus.add(o.get("focusedAfter") or "body")
            if tab_run >= rules.keyboard_trap_tabs and tab_steps >= 3 and len(tab_focus) <= 2:
                out.append(_sig(s, "accessibility", {"kind": "keyboard_trap", "tabs": tab_run}))
                tab_run, tab_steps = 0, 0
                tab_focus.clear()
        else:
            tab_run, tab_steps = 0, 0
            tab_focus.clear()
        if t and not t.get("name"):
            out.append(_sig(s, "accessibility", {"kind": "no_accessible_name", "selector": t["selector"], "role": t["role"]}))
        if o.get("actionError") and re.search(r"cannot activate|could not activate", o["actionError"], re.I):
            out.append(_sig(s, "accessibility", {"kind": "not_keyboard_operable", "error": o["actionError"]}))

    if steps and outcome:
        last = steps[-1]
        if outcome["status"] == "gave_up":
            out.append(_sig(last, "give_up", {"reason": outcome.get("detail") or ""}))
        elif outcome["status"] in ("failed", "timed_out"):
            out.append(_sig(last, "task_failed", {"status": outcome["status"], "detail": outcome.get("detail") or ""}))
    seen: set[str] = set()
    return [x for x in out if not (x["id"] in seen or seen.add(x["id"]))]
