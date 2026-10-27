"""Act stage: one browser action per step, filtered by the persona's action profile. Pointer actions land where
the element appears on screen, like a real tap: if a cookie banner covers the button, the tap hits the banner.
That is how covered CTAs become evidence."""
from __future__ import annotations

import re
import sys
from typing import Optional

from playwright.async_api import Page

IRREVERSIBLE = re.compile(r"\b(place (my )?order|pay now|buy now|complete purchase|confirm (and )?pay|submit order|send message|delete account)\b", re.I)
POINTER = {"click", "tap", "hover", "select", "scroll"}


def allowed_actions(p: dict, screen_reader: bool) -> list[str]:
    if screen_reader:
        return ["click", "type", "select", "press", "back", "wait", "give_up", "done"]
    if p["keyboardOnly"]:
        return ["press", "type", "back", "wait", "give_up", "done"]
    base = ["tap" if p["touch"] else "click", "type", "select", "scroll", "press", "back", "wait", "give_up", "done"]
    if not p["touch"]:
        base.append("hover")
    if p["allowGoto"]:
        base.append("goto")
    return base


def _first_line(e: Exception) -> str:
    return str(e).split("\n")[0]


async def act(page: Page, action: dict, elements: list[dict], profile: dict, screen_reader: bool, allow_irreversible: bool,
              focused_mark: Optional[str]) -> dict:
    """Returns an ActResult dict: charsTyped, and optionally error, blockedByPolicy, target, targetCovered, coveredBy,
    scrolledIntoView, targetMoved {dx, dy} (how far the target moved between perception and the tap)."""
    allowed = allowed_actions(profile, screen_reader)
    t = action["type"]
    kind = "click" if t == "tap" and not profile["touch"] else "tap" if t == "click" and profile["touch"] else t
    if kind not in allowed and not (kind == "tap" and "click" in allowed) and not (kind == "click" and "tap" in allowed):
        return {"error": f'action "{t}" is not available to this persona (allowed: {", ".join(allowed)})', "charsTyped": 0}
    if profile["keyboardOnly"] and not screen_reader and t in POINTER:
        return {"error": "keyboard-only persona cannot use pointer actions", "charsTyped": 0}

    def by_mark(mark: int) -> Optional[dict]:
        return next((e for e in elements if e["mark"] == mark), None)

    def loc(mark: int):
        return page.locator(f'[data-sus-mark="{mark}"]').first

    if t in ("click", "tap"):
        target = by_mark(action["mark"])
        if not target:
            return {"error": f"no element with mark {action['mark']}", "charsTyped": 0, "target": None}
        if not allow_irreversible and IRREVERSIBLE.search(target["name"]):
            return {"blockedByPolicy": True, "target": target, "charsTyped": 0}
        if screen_reader:
            # Screen-reader activation: move focus to the element and press Enter. A div with an onclick and no
            # keyboard handler does nothing here, exactly as for a real screen-reader user.
            try:
                await loc(action["mark"]).focus(timeout=2000)
                await page.keyboard.press("Enter")
                return {"target": target, "charsTyped": 0}
            except Exception as e:
                return {"error": f"could not activate element: {_first_line(e)}", "target": target, "charsTyped": 0}
        return await _pointer_activate(page, action["mark"], target, profile["touch"])

    if t == "hover":
        target = by_mark(action["mark"])
        hit = await page.evaluate(f"window.__sus.pointHits({action['mark']})")
        if not target or not hit["found"]:
            return {"error": f"no element with mark {action['mark']}", "charsTyped": 0}
        await page.mouse.move(hit["x"], hit["y"], steps=4)
        return {"target": target, "charsTyped": 0}

    if t == "type":
        target = by_mark(action["mark"])
        if not target:
            return {"error": f"no element with mark {action['mark']}", "charsTyped": 0, "target": None}
        if profile["keyboardOnly"] and not screen_reader and focused_mark != str(action["mark"]):
            return {"error": "keyboard-only persona can only type into the focused field; use Tab to move focus", "target": target, "charsTyped": 0}
        res: dict = {"target": target, "charsTyped": 0}
        if not profile["keyboardOnly"]:
            res = await _pointer_activate(page, action["mark"], target, profile["touch"])
            if res.get("error"):
                return res
        elif screen_reader:
            try:
                await loc(action["mark"]).focus(timeout=2000)
            except Exception:
                pass
        await page.evaluate(f"window.__sus.markTouched({action['mark']})")
        # Replace existing content the way a user would: select all, then type.
        await page.keyboard.press("Meta+A" if sys.platform == "darwin" else "Control+A")
        await page.keyboard.type(action["text"], delay=0)
        if action.get("submit"):
            await page.keyboard.press("Enter")
        return {**res, "charsTyped": len(action["text"])}

    if t == "select":
        target = by_mark(action["mark"])
        if not target:
            return {"error": f"no element with mark {action['mark']}", "charsTyped": 0}
        try:
            try:
                await loc(action["mark"]).select_option(label=action["option"], timeout=3000)
            except Exception:
                await loc(action["mark"]).select_option(action["option"], timeout=3000)
            await page.evaluate(f"window.__sus.markTouched({action['mark']})")
            return {"target": target, "charsTyped": 0}
        except Exception as e:
            return {"error": f'could not select "{action["option"]}": {_first_line(e)}', "target": target, "charsTyped": 0}

    if t == "scroll":
        vh = ((page.viewport_size or {}).get("height") or 800) * 0.8
        await page.mouse.wheel(0, vh if action["direction"] == "down" else -vh)
        await page.wait_for_timeout(300)
        return {"charsTyped": 0}

    if t == "press":
        for _ in range(max(1, min(10, int(action.get("times") or 1)))):
            await page.keyboard.press(normalize_key(action["key"]))
        return {"charsTyped": 0}

    if t == "back":
        try:
            await page.go_back(timeout=15_000)
        except Exception:
            pass
        return {"charsTyped": 0}

    if t == "wait":
        await page.wait_for_timeout(max(0, min(10, float(action["seconds"]))) * 1000)
        return {"charsTyped": 0}

    if t == "goto":
        try:
            await page.goto(action["url"], timeout=30_000)
        except Exception as e:
            return {"error": _first_line(e), "charsTyped": 0}
        return {"charsTyped": 0}

    return {"charsTyped": 0}  # give_up, done


async def _pointer_activate(page: Page, mark: int, target: dict, touch: bool) -> dict:
    hit = await page.evaluate(f"window.__sus.pointHits({mark})")
    scrolled = False
    if not hit["found"]:
        # Element re-rendered: fall back to its last known coordinates (spec: coordinate fallback).
        box = target["box"]
        pos = await page.evaluate("({x: scrollX, y: scrollY})")
        hit = {"found": True, "x": box["x"] + box["width"] / 2 - pos["x"], "y": box["y"] + box["height"] / 2 - pos["y"],
               "inView": True, "covered": False, "coveredBy": None}
    elif not hit["inView"]:
        # A user scrolls the element into view before tapping it.
        try:
            await page.locator(f'[data-sus-mark="{mark}"]').first.scroll_into_view_if_needed(timeout=3000)
        except Exception:
            pass
        await page.wait_for_timeout(200)
        hit = await page.evaluate(f"window.__sus.pointHits({mark})")
        scrolled = True
    # A person aims where the element WAS when they looked. If it moved since, they hit whatever is there now.
    moved = None
    vb = target.get("vbox")
    if not scrolled and vb:
        dx = round(hit["x"] - (vb["x"] + vb["width"] / 2))
        dy = round(hit["y"] - (vb["y"] + vb["height"] / 2))
        if abs(dx) > 24 or abs(dy) > 24:
            moved = {"dx": dx, "dy": dy}
    x, y = (vb["x"] + vb["width"] / 2, vb["y"] + vb["height"] / 2) if moved else (hit["x"], hit["y"])
    if touch:
        await page.touchscreen.tap(x, y)
    else:
        await page.mouse.click(x, y)
    out = {"target": target, "targetCovered": hit.get("covered"), "coveredBy": hit.get("coveredBy"), "scrolledIntoView": scrolled, "charsTyped": 0}
    if moved:
        out["targetMoved"] = moved
    return out


_KEYS = {
    "enter": "Enter", "return": "Enter", "tab": "Tab", "shift+tab": "Shift+Tab", "space": "Space", " ": "Space",
    "esc": "Escape", "escape": "Escape", "up": "ArrowUp", "down": "ArrowDown", "left": "ArrowLeft", "right": "ArrowRight",
    "pagedown": "PageDown", "pageup": "PageUp", "backspace": "Backspace",
}


def normalize_key(k: str) -> str:
    return _KEYS.get(k.strip().lower(), k)
