"""Deterministic offline step policy, used when SWARM_MODEL_MODE=mock (tests, CI, no API key). It is deliberately
simple: keyword matching between the task and element names. It exercises the whole pipeline (perception,
actions, evidence, signals, analysis, report) without spending tokens."""
from __future__ import annotations

import re
from dataclasses import dataclass, field

from ..analysis.embed import tokens

PROGRESS = [
    "add to bag", "add to cart", "view bag", "bag", "cart", "checkout", "check out", "continue as guest", "guest",
    "continue", "next", "place order", "pay", "submit", "sign up", "create account", "register",
]
# Words that only count as progress when the goal itself mentions them.
GOAL_ONLY = ["subscribe", "newsletter", "search", "coupon"]
DISMISS = re.compile(r"^(close|×|x|no thanks|dismiss|accept|accept all|got it|ok|not now|maybe later)$", re.I)
DONE_TEXT = re.compile(r"(order confirmed|thank you for your order|you're subscribed|account created|welcome,)", re.I)

FIELD_VALUES = [
    (re.compile(r"e-?mail", re.I), "sam.tester@example.com"),
    (re.compile(r"phone|mobile|tel", re.I), "5551234567"),
    (re.compile(r"first", re.I), "Sam"),
    (re.compile(r"last|surname", re.I), "Tester"),
    (re.compile(r"name", re.I), "Sam Tester"),
    (re.compile(r"address|street", re.I), "1 Test Street"),
    (re.compile(r"city|town", re.I), "Springfield"),
    (re.compile(r"zip|post", re.I), "12345"),
    (re.compile(r"card number|card", re.I), "4242424242424242"),
    (re.compile(r"expir|mm", re.I), "12/30"),
    (re.compile(r"cvc|cvv|security", re.I), "123"),
    (re.compile(r"password", re.I), "Correct-Horse-9"),
    (re.compile(r"search", re.I), "gift"),
    (re.compile(r"coupon|promo|code", re.I), "WELCOME10"),
]
_NOISE = re.compile(r"newsletter|subscribe|coupon|promo", re.I)


@dataclass
class MockMemory:
    clicked: dict[str, int] = field(default_factory=dict)
    typed: set[str] = field(default_factory=set)
    failures: int = 0
    scrolls: int = 0


def _step(think: str, conf: float, frus: float, action: dict, says: str, check: dict) -> dict:
    return {"think_aloud": think, "confidence": conf, "frustration": frus, "action": action, "expectation": {"says": says, "check": check}}


def mock_step(view: dict, goal: str, mem: MockMemory, keyboard_only: bool, touch: bool, last_failed: bool) -> dict:
    if last_failed:
        mem.failures += 1
    frustration = min(10, mem.failures * 2)

    def click(e: dict, why: str) -> dict:
        mem.clicked[e["name"]] = mem.clicked.get(e["name"], 0) + 1
        action = {"type": "tap" if touch else "click", "mark": e["mark"]}
        if e["role"] == "link":
            return _step(why, max(1, 4 - mem.failures), frustration, action, f'A new page opens for "{e["name"]}"', {"type": "url_changes"})
        return _step(why, max(1, 4 - mem.failures), frustration, action, f'Something visibly changes after pressing "{e["name"]}"',
                     {"type": "element_changes", "mark": e["mark"]})

    body = " ".join(b["text"] for b in view["blocks"])
    m = DONE_TEXT.search(body)
    if m:
        return _step("It looks like I'm done.", 5, frustration, {"type": "done", "claim": m.group(0)}, "Nothing more to do", {"type": "none"})
    if mem.failures >= 6:
        return _step("I've tried everything I can think of. I give up.", 1, 10, {"type": "give_up", "reason": "could not find a way forward"}, "I stop", {"type": "none"})

    if keyboard_only:
        focused = next((e for e in view["elements"] if str(e["mark"]) == str(view.get("focused"))), None)
        if focused and _score(focused, goal, mem) > 2:
            mem.clicked[focused["name"]] = mem.clicked.get(focused["name"], 0) + 1
            return _step(f'Focus is on "{focused["name"]}", I\'ll press Enter.', 3, frustration, {"type": "press", "key": "Enter"}, "Something happens", {"type": "url_changes"})
        return _step("Moving focus forward.", 2, frustration, {"type": "press", "key": "Tab"}, "Focus moves", {"type": "focus_moves"})

    if view.get("dialogOpen"):
        close = next((e for e in view["elements"] if DISMISS.match(e["name"].strip()) and e["inView"] and not e["covered"]), None)
        if close and mem.clicked.get(close["name"], 0) < 3:
            return click(close, "A pop-up. I'll close it.")

    # Fill fields that serve the goal; leave newsletter, coupon and search boxes alone unless the goal asks.
    wants_search = bool(re.search("search", goal, re.I)) and not any(re.search("search", k, re.I) for k in mem.typed)

    def fillable(e: dict) -> bool:
        if e["role"] not in ("textbox", "searchbox") or any(s.startswith("value=") for s in e["state"]) or _field_key(e) in mem.typed or not e["inView"]:
            return False
        if e["role"] == "searchbox" or re.search("search", e["name"], re.I):
            return wants_search
        return not _NOISE.search(e["name"]) or bool(_NOISE.search(goal))

    fld = next((e for e in view["elements"] if fillable(e)), None)
    if fld:
        is_search = fld["role"] == "searchbox" or re.search("search", fld["name"], re.I)
        value = _search_query(goal) if is_search else next((v for rx, v in FIELD_VALUES if rx.search(fld["name"])), "test")
        mem.typed.add(_field_key(fld))
        return _step(f'I\'ll fill in "{fld["name"] or "this box"}".', 3, frustration,
                     {"type": "type", "mark": fld["mark"], "text": value, "submit": fld["role"] == "searchbox"},
                     "My text appears in the box", {"type": "element_changes", "mark": fld["mark"]})

    ranked = sorted(
        ((e, _score(e, goal, mem)) for e in view["elements"] if "disabled" not in e["state"] and e["role"] not in ("textbox", "searchbox", "combobox")),
        key=lambda x: -x[1],
    )
    ranked = [x for x in ranked if x[1] > 0]
    if ranked and ranked[0][1] >= 2:
        return click(ranked[0][0], f'"{ranked[0][0]["name"]}" looks like the way forward.')

    if view["scroll"]["y"] < view["scroll"]["max"] - 5 and mem.scrolls < 6:
        mem.scrolls += 1
        return _step("I can't see what I need. Let me scroll.", 2, frustration, {"type": "scroll", "direction": "down"}, "More of the page shows", {"type": "none"})
    mem.failures += 1
    if ranked:
        return click(ranked[0][0], f'Maybe "{ranked[0][0]["name"]}"?')
    return _step("I'm lost. Going back.", 1, frustration, {"type": "back"}, "The previous page", {"type": "url_changes"})


def _search_query(goal: str) -> str:
    m = re.search(r"(gift|present|scarf|mug|candle|earbuds|game)[^.,]*", goal, re.I)
    return " ".join(m.group(0).split(" ")[:4]) if m else "gift"


def _field_key(e: dict) -> str:
    return f'{e["name"]}|{e["selector"]}'


def _score(e: dict, goal: str, mem: MockMemory) -> float:
    name = e["name"].lower()
    if not name:
        return 0
    s = 0.0
    pi = next((i for i, p in enumerate(PROGRESS) if p in name), -1)
    if pi >= 0:
        s += 3 + pi * 0.2
    if any(w in name and w not in goal.lower() for w in GOAL_ONLY):
        s -= 3
    g = set(tokens(goal))
    for t in tokens(name):
        if t in g:
            s += 1.5
    if e["role"] == "link" and re.search(r"product|gift|mug|scarf|candle", name, re.I) and re.search(r"gift|buy|product", goal, re.I):
        s += 1
    s -= mem.clicked.get(e["name"], 0) * 2.5
    if not e["inView"]:
        s -= 0.5
    return s
