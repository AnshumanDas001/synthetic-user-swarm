import itertools
import secrets

_n = itertools.count()


def step(idx=None, obs=None, **rest):
    """A recorded step with sensible defaults; override any field."""
    idx = next(_n) if idx is None else idx
    s = {
        "id": f"stp_{idx}_{secrets.token_hex(3)}", "sessionId": "ses_1", "idx": idx, "url": "http://shop.test/bag", "pagePath": "/bag",
        "title": "Bag", "stateHash": f"h{idx}", "action": {"type": "click", "mark": 1}, "thinkAloud": "",
        "expectation": {"says": "", "check": {"type": "none"}}, "confidence": 3, "frustration": 2,
        "target": {"mark": 1, "selector": "#checkout", "name": "Checkout", "role": "button", "box": {"x": 10, "y": 10, "width": 80, "height": 30}},
        "artifacts": {}, "tokensIn": 0, "tokensOut": 0, "costUsd": 0, "model": "mock", "estHumanMs": 1000, "startedAt": 0, "endedAt": 0,
    }
    s.update(rest)
    s["observation"] = {
        "urlBefore": "http://shop.test/bag", "urlAfter": "http://shop.test/bag", "navigated": False, "domChanged": True, "networkCalls": 0,
        "networkErrors": [], "consoleErrors": [], "expectationMet": None, "dialogOpened": False, "validationMessages": [], "wordsSeen": 20,
        "layoutShift": 0, "focusChanged": False, "focusedAfter": None, **(obs or {}),
    }
    return s
