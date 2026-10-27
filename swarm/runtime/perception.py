"""Perceive stage: what the agent sees each step, after the persona's perception filter. Screenshot with
Set-of-Marks + compact element list + URL/title/page-changed + (screen reader) a11y tree."""
from __future__ import annotations

import base64
import json
import re
from typing import Optional
from urllib.parse import urlsplit

from playwright.async_api import Page

from ..config import config
from ..util import sha256
from .sandbox import sensitive_locators

# A PageView is a dict: url, title, elements, blocks, wordsSeen, validation, dialogOpen, searchZeroResults,
# scroll {y, max, vh, vw}, focused, textHash, stateHash, ariaSnapshot?, and screenshots shotClean (evidence),
# shotMarked (with marks) and shotModel (what the model is shown, after filters).


async def collect(page: Page, profile: dict) -> dict:
    raw = await page.evaluate(f"window.__sus ? window.__sus.collect({json.dumps({'skim': profile['skim'], 'skimWords': profile['skimWords']})}) : null")
    if not raw:
        raise RuntimeError("perception helpers missing on page")
    return raw


def state_hash(url: str, elements: list[dict], text_hash: str, scroll: Optional[dict] = None) -> str:
    """"What is on screen": the page, its controls, its text and (coarsely) how far down it is scrolled.
    Scrolling a long page is progress; seeing the same screen three times is a loop."""
    try:
        u = urlsplit(url)
        path_only = (u.path or "/") + (f"?{u.query}" if u.query else "") if u.scheme else url
    except ValueError:
        path_only = url
    sig = ";".join(f"{e['role']}:{e['name']}:{'|'.join(s for s in e['state'] if s != 'focused')}" for e in elements)
    # Keyboard focus is part of the state: for a keyboard user, moving focus is moving.
    focus = next((e for e in elements if "focused" in e["state"]), None)
    band = int(scroll["y"] // (scroll["vh"] / 2)) if scroll and scroll.get("vh", 0) > 0 else 0
    focus_s = f"{focus['selector']}:{focus['name']}" if focus else ""
    return sha256(f"{path_only}#{sig}#{text_hash}#{focus_s}#{band}")[:16]


async def perceive(page: Page, profile: dict) -> dict:
    try:
        await page.wait_for_load_state("domcontentloaded", timeout=15_000)
    except Exception:
        pass
    # Let pending renders settle briefly; not a network-idle wait (some sites never go idle).
    await page.wait_for_timeout(250)
    view = await collect(page, profile)
    view["stateHash"] = state_hash(view["url"], view["elements"], view["textHash"], view["scroll"])

    mask = sensitive_locators(page)

    async def shot() -> bytes:
        return await page.screenshot(type="jpeg", quality=70, scale="css", mask=mask, animations="disabled", timeout=15_000)

    view["shotClean"] = await shot()
    await page.evaluate("window.__sus.drawMarks()")
    view["shotMarked"] = await shot()

    if profile["screenshot"] == "none":
        # Screen reader: no screenshot at all, only the accessibility tree in reading order.
        view["shotModel"] = None
        try:
            view["ariaSnapshot"] = await page.locator("body").aria_snapshot(timeout=10_000)
        except Exception:
            view["ariaSnapshot"] = ""
    elif profile["colorVision"] != "normal" or profile["skim"]:
        await page.evaluate(f"window.__sus.setVision({json.dumps(profile['colorVision'])}); window.__sus.setSkim({'true' if profile['skim'] else 'false'})")
        view["shotModel"] = await _model_shot(page, view["scroll"]["vw"], view["scroll"]["vh"]) or await shot()
        await page.evaluate('window.__sus.setVision("normal"); window.__sus.setSkim(false)')
    else:
        view["shotModel"] = await _model_shot(page, view["scroll"]["vw"], view["scroll"]["vh"]) or view["shotMarked"]
    await page.evaluate("window.__sus.clearMarks()")
    return view


_cdp: dict[int, object] = {}


async def _model_shot(page: Page, vw: float, vh: float) -> Optional[bytes]:
    """What the model sees, downscaled so wide desktop viewports cost fewer image tokens (Chromium CDP capture
    with a scale factor). None when no downscaling is needed or CDP is unavailable."""
    scale = config.model_image_max_width / vw if vw else 1
    if scale >= 1:
        return None
    try:
        cdp = _cdp.get(id(page))
        if cdp is None:
            cdp = await page.context.new_cdp_session(page)
            _cdp[id(page)] = cdp
            page.on("close", lambda *_: _cdp.pop(id(page), None))
        # Clip coordinates are page coordinates, so offset by the current scroll position.
        pos = await page.evaluate("({ x: scrollX, y: scrollY })")
        res = await cdp.send("Page.captureScreenshot", {"format": "jpeg", "quality": 65, "clip": {"x": pos["x"], "y": pos["y"], "width": vw, "height": vh, "scale": scale}})
        return base64.b64decode(res["data"])
    except Exception:
        return None


def describe_view(view: dict, screen_reader: bool, keyboard_only: bool, changed: bool) -> str:
    """Compact text the model reads next to the screenshot."""
    lines = [f"URL: {view['url']}", f"Title: {view['title']}", f"Page changed since your last action: {'yes' if changed else 'no'}"]
    if view.get("dialogOpen"):
        lines.append("A dialog or pop-up is open.")
    if view.get("validation"):
        lines.append("Messages on screen: " + "; ".join(f'"{v}"' for v in view["validation"]))
    lines.append(f"Scroll: {_n(view['scroll']['y'])}px of {_n(view['scroll']['max'])}px")
    if keyboard_only:
        lines.append(f"Keyboard focus is on: {'[' + str(view['focused']) + ']' if view.get('focused') else 'nothing (page body)'}")
    if screen_reader:
        lines += ["", "Screen reader output (accessibility tree, reading order):", (view.get("ariaSnapshot") or "")[:6000],
                  "", "Elements you can jump to with the screen reader's elements list:"]
    else:
        lines += ["", "Interactive elements (mark, role, name, state, in view):"]
    for e in view["elements"]:
        name = f'"{e["name"][:70]}"' if e["name"] else "(unlabeled)" if screen_reader else "(no accessible name)"
        flags = ", ".join(x for x in [*e["state"], "" if e["inView"] else "off-screen", "partly covered" if e["covered"] and e["inView"] else ""] if x)
        lines.append(f"[{e['mark']}] {e['role']} {name}{f' ({flags})' if flags else ''}")
    if not screen_reader and view["blocks"]:
        lines += ["", "Text you can see:"]
        for b in view["blocks"][:40]:
            lines.append(("# " if re.fullmatch(r"h\d", b["tag"]) else "- ") + b["text"])
    return "\n".join(lines)


def _n(x: float) -> str:
    return str(int(x)) if float(x).is_integer() else str(x)
