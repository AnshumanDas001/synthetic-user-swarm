"""Browser agent runtime: perceive -> think -> act -> check, one action per step, until done, give_up, budget,
or loop detection. Every step writes its evidence before the next action runs."""
from __future__ import annotations

import asyncio
import json
import re
import time
from typing import Any, Awaitable, Callable, Optional, Protocol

from playwright.async_api import Page
from pydantic import BaseModel

from ..config import config
from ..llm.client import RefusalError, SchemaError, image_block, is_fatal, is_retryable, structured, text_block
from ..llm.mock import MockMemory, mock_step
from ..llm.prompts import JUDGE_SYSTEM, persona_system_prompt, step_prompt
from ..models import AgentStep, PersonaCard, TaskSpec
from ..store.blobs import BlobStore
from ..util import new_id, now_ms, page_path, redact
from .actions import act, allowed_actions
from .check import check_success, estimate_human_ms, expectation_met, marks_for, snapshot
from .perception import describe_view, perceive
from .robots import robots_blocks
from .sandbox import AXE_SOURCE, Sandbox

COST_CAP_DETAIL = "study cost cap reached"
_PRIMARY = re.compile(r"checkout|pay|place order|continue|submit|buy|add to", re.I)
_NOISE = re.compile(r"image|font|media")


class InfraError(Exception):
    pass


class FatalError(Exception):
    pass


class AgentHooks(Protocol):
    async def on_step(self, step: dict, view: dict) -> None: ...
    def on_audit(self, step: dict, violations: list) -> None: ...
    def cost_guard(self) -> bool: ...  # False once the study's cost cap is reached


class JudgeVerdict(BaseModel):
    achieved: bool
    evidence: str


async def run_agent(*, session_id: str, study_id: str, card: PersonaCard, task: TaskSpec, start_url: str, perception: dict,
                    action_profile: dict, budget: dict, sandbox: Sandbox, blobs: BlobStore, hooks: AgentHooks,
                    resume_from: Optional[list[dict]] = None, robots: Optional[dict] = None) -> dict:
    """Returns {end: {status, detail}, steps, tokens, cost}."""
    page = sandbox.page
    screen_reader = perception["screenshot"] == "none"
    allowed = allowed_actions(action_profile, screen_reader)
    system = persona_system_prompt(card, task, allowed)
    steps: list[dict] = list(resume_from or [])
    history = [_to_history(s) for s in steps[-config.history_steps:]]
    notes: list[str] = []
    mem = MockMemory()
    audited: set[str] = set()
    t0 = now_ms()
    tokens = 0
    cost = 0.0
    escalate_left = 0
    cooldown = 0
    last_image_hash: Optional[str] = None
    obstacle_attempts = 0
    last_error: Optional[str] = None
    last_state_hash: Optional[str] = steps[-1]["stateHash"] if steps else None
    last_cls = 0.0

    def finish(status: str, detail: str) -> dict:
        return {"end": {"status": status, "detail": detail}, "steps": steps, "tokens": tokens, "cost": cost}

    # Durable resume: return to where the last recorded step left the persona.
    await goto_with_backoff(page, steps[-1]["url"] if steps else start_url)

    idx = len(steps)
    while True:
        if idx >= budget["maxSteps"]:
            return finish("failed", f"step budget of {budget['maxSteps']} reached")
        if now_ms() - t0 > budget["wallClockMs"]:
            return finish("timed_out", "wall-clock budget reached")
        if tokens > budget["maxTokens"]:
            return finish("failed", "token budget reached")
        if not hooks.cost_guard():
            return finish("infra_error", COST_CAP_DETAIL)

        step_id = new_id("stp")
        sandbox.current_step_id = step_id
        started_at = now_ms()

        # ---------------- perceive
        view = await perceive(page, perception)
        prefix = f"{study_id}/{session_id}/{idx:03d}"
        artifacts: dict[str, str] = {}
        if view.get("shotClean"):
            artifacts["before"] = blobs.put(prefix, view["shotClean"], "jpg")
        if view.get("shotMarked"):
            artifacts["before_marked"] = blobs.put(prefix, view["shotMarked"], "jpg")
        if view.get("shotModel") and view["shotModel"] is not view.get("shotMarked"):
            artifacts["model_view"] = blobs.put(prefix, view["shotModel"], "jpg")
        artifacts["elements"] = blobs.put(prefix, json.dumps(view["elements"]), "json")
        if view.get("ariaSnapshot"):
            artifacts["a11y"] = blobs.put(prefix, view["ariaSnapshot"], "yaml")
        # Visible text, so issues about copy (jargon, unclear labels) can cite what was on screen.
        artifacts["text"] = blobs.put(prefix, json.dumps(view["blocks"]), "json")
        # Layout shift since this page loaded, measured before acting: content that jumped on arrival.
        prev = steps[-1] if steps else None
        arrived = prev is None or prev["pagePath"] != page_path(view["url"]) or prev["observation"].get("navigated")
        load_shift = 0.0
        if arrived:
            try:
                load_shift = float(await page.evaluate("window.__sus ? window.__sus.counters().lateCls : 0") or 0)
            except Exception:
                load_shift = 0.0

        # Accessibility audit on each new page (axe-core).
        pp = page_path(view["url"])
        violations = None
        if pp not in audited:
            audited.add(pp)
            violations = await _run_axe(page)
            if violations is not None:
                artifacts["axe"] = blobs.put(prefix, json.dumps(violations), "json")

        # Loop detection: the same page state three times in a row while repeating the same action ends the
        # session. A persona trying different things on an unchanged page is stopped by the retry cap instead.
        last_two = steps[-2:]
        if len(last_two) == 2 and all(s["stateHash"] == view["stateHash"] for s in last_two) and _same_action(last_two[0], last_two[1]):
            return finish("failed", "loop detected (same page state 3 times, same action repeated)")

        # ---------------- think
        changed = last_state_hash != view["stateHash"]
        view_text = describe_view(view, screen_reader, action_profile["keyboardOnly"], changed)
        # Model routing: when the agent is stuck it thinks harder (higher effort, or a stronger model if one is
        # configured) for a few steps, then drops back and must cool down before escalating again.
        stuck = obstacle_attempts >= 2 or (prev["frustration"] if prev else 0) >= 7
        if stuck and escalate_left == 0 and cooldown == 0:
            escalate_left = config.escalation_steps
        escalated = escalate_left > 0
        model = card.model or (config.models.escalation if escalated else config.models.step)
        if escalate_left > 0:
            escalate_left -= 1
            if escalate_left == 0:
                cooldown = config.escalation_steps
        elif cooldown > 0:
            cooldown -= 1

        usage = {"tokensIn": 0, "tokensOut": 0, "costUsd": 0.0, "model": "mock"}
        if config.model_mode == "mock":
            decision = mock_step(view, task.goal, mem, keyboard_only=action_profile["keyboardOnly"] and not screen_reader,
                                 touch=action_profile["touch"], last_failed=obstacle_attempts > 0)
        else:
            # Cost lever: no screenshot when the page has not changed since the last one the model saw.
            send_image = bool(view.get("shotModel")) and view["stateHash"] != last_image_hash
            if send_image:
                last_image_hash = view["stateHash"]
            same = "(The screen looks exactly as it did on your previous step, so no new screenshot.)\n\n" if not send_image and view.get("shotModel") else ""
            content = ([image_block(view["shotModel"])] if send_image else []) + [text_block(same + step_prompt(
                view_text, history[-config.history_steps:], notes, budget["maxSteps"] - idx, obstacle_attempts, last_error))]
            effort = config.effort.escalation if escalated else config.effort.step
            wasted = [0.0]
            try:
                value, u = await call_with_retry(
                    lambda: structured(model=model, schema=AgentStep, system=system, content=content, effort=effort, max_tokens=4000, name="agent_step"),
                    lambda usd: wasted.__setitem__(0, wasted[0] + usd))
            except RefusalError as e:
                return finish("infra_error", str(e))
            except Exception as e:
                if is_fatal(e):
                    raise FatalError(f"OpenRouter stopped the run: {str(e).splitlines()[0]}") from e
                raise InfraError(f"step model failed: {e}") from e
            decision = value.model_dump(exclude_none=True)
            decision["think_aloud"] = redact(value.think_aloud)
            decision["confidence"] = round(min(5, max(1, value.confidence)))
            decision["frustration"] = round(min(10, max(0, value.frustration)))
            usage = {**u, "costUsd": u["costUsd"] + wasted[0]}
        tokens += usage["tokensIn"] + usage["tokensOut"]
        cost += usage["costUsd"]
        if decision.get("note"):
            notes.append(decision["note"][:160])
        if len(notes) > 8:
            notes.pop(0)

        action = decision["action"]
        check = decision["expectation"]["check"]

        # ---------------- act
        before = await snapshot(page, marks_for(check), bool(view.get("dialogOpen")), view.get("focused"))
        await _eval(page, "window.__sus && window.__sus.resetCounters()")
        net_before, console_before = len(sandbox.network), len(sandbox.console)
        acted_at = now_ms()
        try:
            res = await act(page, action, view["elements"], action_profile, screen_reader, task.allow_irreversible, view.get("focused"))
        except Exception as e:
            res = {"error": str(e).split("\n")[0], "charsTyped": 0}

        # ---------------- check (pure code)
        await _settle(page)
        # Slow response: a request this action started is still running after the settle window. Wait for it
        # (up to 8 s) and note whether the page showed any progress meanwhile.
        slow_request = None
        pending = [(k, r) for k, r in list(sandbox.inflight.items()) if r["startedAt"] >= acted_at - 50]
        if pending:
            key, r = pending[0]
            await _eval(page, "window.__sus && window.__sus.resetCounters()")
            wait_start = time.monotonic()
            while key in sandbox.inflight and time.monotonic() - wait_start < 8:
                await asyncio.sleep(0.2)
            during = await _eval(page, "window.__sus ? window.__sus.counters().mutations : 0", 0)
            ms = now_ms() - r["startedAt"]
            if ms >= 2000:
                slow_request = {"url": r["url"], "method": r["method"], "ms": ms, "domChangedWhileWaiting": (during or 0) > 0}
            await _settle(page)
        counters = await _eval(page, "window.__sus ? window.__sus.counters() : {mutations:0,cls:0}", None) or {"mutations": 0, "cls": 0}
        after_view = await _quick_state(page)
        after = await snapshot(page, marks_for(check), after_view["dialogOpen"], after_view["focused"])
        new_net = [n for n in sandbox.network[net_before:] if n["startedAt"] <= acted_at + 1000 and not _NOISE.search(n["resourceType"])]
        navigated = before["url"].split("#")[0] != after["url"].split("#")[0]
        is_active = action["type"] not in ("give_up", "done", "wait")
        met = expectation_met(check, before, after) if is_active and not res.get("error") and not res.get("blockedByPolicy") else None
        target = res.get("target")

        observation: dict[str, Any] = {
            "urlBefore": before["url"], "urlAfter": after["url"], "navigated": navigated,
            "domChanged": (counters.get("mutations") or 0) > 0 or navigated,
            "networkCalls": len(new_net),
            "networkErrors": [{"url": n["url"], "status": n["status"], "method": n["method"]} for n in sandbox.network[net_before:] if n["status"] >= 400 or n["failed"]],
            "consoleErrors": [c["text"] for c in sandbox.console[console_before:]],
            "expectationMet": met,
            "dialogOpened": not before["dialogOpen"] and after_view["dialogOpen"],
            "validationMessages": after_view["validation"],
            "searchZeroResults": after_view["searchZeroResults"],
            "wordsSeen": view["wordsSeen"],
            "layoutShift": max(0.0, (counters.get("cls") or 0) - last_cls),
            "focusChanged": before["focused"] != after_view["focused"],
            "focusedAfter": after_view["focusedSelector"],
        }
        for k in ("targetCovered", "scrolledIntoView", "blockedByPolicy", "targetMoved"):
            if res.get(k) is not None:
                observation[k] = res[k]
        if res.get("error"):
            observation["actionError"] = res["error"]
        observation["primaryActionOffscreen"] = bool(res.get("scrolledIntoView") and target and _PRIMARY.search(target["name"]))
        if load_shift > 0:
            observation["loadShift"] = round(load_shift, 3)
        if slow_request:
            observation["slowRequest"] = slow_request
        last_cls = counters.get("cls") or 0

        try:
            shot_after = await page.screenshot(type="jpeg", quality=70, scale="css", timeout=15_000)
            artifacts["after"] = blobs.put(prefix, shot_after, "jpg")
        except Exception:
            pass

        step = {
            "id": step_id, "sessionId": session_id, "idx": idx, "url": view["url"], "pagePath": pp, "title": view["title"],
            "stateHash": view["stateHash"], "action": action, "thinkAloud": decision["think_aloud"], "expectation": decision["expectation"],
            "confidence": decision["confidence"], "frustration": decision["frustration"],
            "target": {k: target.get(k) for k in ("mark", "selector", "name", "role", "box", "vbox")} if target else None,
            "observation": observation, "artifacts": artifacts, "tokensIn": usage["tokensIn"], "tokensOut": usage["tokensOut"],
            "costUsd": usage["costUsd"], "model": usage["model"],
            "estHumanMs": estimate_human_ms(card, action, view["wordsSeen"], res.get("charsTyped", 0)),
            "startedAt": started_at, "endedAt": now_ms(),
        }
        steps.append(step)
        await hooks.on_step(step, view)
        if violations is not None:
            hooks.on_audit(step, violations)

        # Obstacle tracking: consecutive steps that made no visible progress.
        progressed = navigated or met is True or (view["stateHash"] != last_state_hash and not res.get("error"))
        obstacle_attempts = 0 if progressed else obstacle_attempts + 1
        last_error = res.get("error")
        last_state_hash = view["stateHash"]
        history.append(_to_history(step))

        # Off-limits (robots.txt): an in-app route change into a disallowed path is undone, and the persona is told.
        if robots_blocks(robots, page.url):
            try:
                await page.go_back(timeout=10_000)
            except Exception:
                pass
            if robots_blocks(robots, page.url):
                await goto_with_backoff(page, start_url)
            last_error = "that part of the site is off-limits for this study (the site asks automated visitors not to go there); try another way"

        # ---------------- stop conditions
        if res.get("blockedByPolicy"):
            return finish("succeeded", f'reached irreversible action "{(target or {}).get("name")}" (blocked by safety policy)')
        if action["type"] == "give_up":
            return finish("gave_up", action["reason"])
        if action["type"] == "done":
            verdict = await _verify_success(page, task, sandbox)
            if verdict["success"]:
                return finish("succeeded", ", ".join(c["kind"] for c in verdict["checks"] if c["passed"]))
            return finish("failed", f'agent claimed "{action["claim"]}" but success checks failed')
        # Success can also be reached without the agent noticing (checked independently every step).
        if navigated or observation["domChanged"]:
            verdict = check_success(task.success.model_copy(update={"llm_judge": None}), page.url, after["bodyText"], sandbox.network)
            if verdict["success"]:
                return finish("succeeded", ", ".join(c["kind"] for c in verdict["checks"] if c["passed"]))
        if obstacle_attempts > budget["maxRetriesPerObstacle"] + 2:
            # Hard retry cap per obstacle (counter to over-patience bias).
            return finish("gave_up", f"retry cap reached at {pp}")
        idx += 1


def _same_action(a: dict, b: dict) -> bool:
    return a["action"] == b["action"] or (bool(a.get("target")) and a["target"]["selector"] == (b.get("target") or {}).get("selector") and a["action"]["type"] == b["action"]["type"])


def _to_history(s: dict) -> dict:
    a = s["action"]
    desc = a["type"]
    if "mark" in a:
        name = (s.get("target") or {}).get("name")
        desc += f" [{a['mark']}]" + (f' "{name}"' if name else "")
    if "text" in a:
        desc += f' "{a["text"]}"'
    if "key" in a:
        desc += f" {a['key']}"
    if "direction" in a:
        desc += f" {a['direction']}"
    o = s["observation"]
    if o.get("actionError"):
        result = f"failed: {o['actionError']}"
    elif o.get("navigated"):
        result = f"moved to {page_path(o['urlAfter'])}"
    elif o.get("expectationMet") is False:
        result = "what you expected did not happen"
    elif o.get("domChanged"):
        result = "the page changed"
    else:
        result = "nothing visible happened"
    return {"idx": s["idx"], "thinkAloud": s["thinkAloud"], "action": desc, "result": result}


async def _eval(page: Page, js: str, default: Any = None) -> Any:
    try:
        return await page.evaluate(js)
    except Exception:
        return default


async def _settle(page: Page) -> None:
    try:
        await page.wait_for_load_state("domcontentloaded", timeout=10_000)
    except Exception:
        pass
    await page.wait_for_timeout(1000)  # the dead-click window: DOM change, navigation or network within ~1 s


async def _quick_state(page: Page) -> dict:
    r = await _eval(page, "window.__sus ? window.__sus.inspect() : null")
    return r or {"dialogOpen": False, "focused": None, "focusedSelector": None, "validation": [], "searchZeroResults": False}


async def _run_axe(page: Page) -> Optional[list]:
    try:
        if not await page.evaluate("typeof window.axe !== 'undefined'"):
            await page.evaluate(AXE_SOURCE)
        res = await page.evaluate("axe.run(document, { resultTypes: ['violations'] })")
        return [{"id": v["id"], "impact": v.get("impact"), "help": v["help"], "helpUrl": v["helpUrl"],
                 "nodes": [{"target": [str(t) for t in n["target"]], "html": n["html"][:300]} for n in v["nodes"][:10]]}
                for v in res["violations"]]
    except Exception:
        return None


async def _verify_success(page: Page, task: TaskSpec, sandbox: Sandbox) -> dict:
    body = await _eval(page, "document.body ? document.body.innerText : ''", "") or ""
    judge = None
    if task.success.llm_judge and config.model_mode == "live":
        shot = await page.screenshot(type="jpeg", quality=70, scale="css")
        value, _ = await structured(model=config.models.judge, schema=JudgeVerdict, system=JUDGE_SYSTEM,
                                    content=[image_block(shot), text_block(f"Goal: {task.success.llm_judge}\n\nPage text (truncated):\n{body[:4000]}")],
                                    effort="low", name="success_judge")
        judge = {"passed": value.achieved, "detail": value.evidence}
    return check_success(task.success, page.url, body, sandbox.network, judge)


async def goto_with_backoff(page: Page, url: str) -> None:
    """Politeness: back off on 429/5xx for the main document; persistent failures are infra errors, not findings."""
    for attempt in range(4):
        try:
            res = await page.goto(url, wait_until="domcontentloaded", timeout=30_000)
            if res and (res.status == 429 or res.status >= 500):
                if attempt == 3:
                    raise InfraError(f"site returned {res.status} repeatedly")
            else:
                return
        except InfraError:
            raise
        except Exception as e:
            if attempt == 3:
                raise InfraError(f"navigation failed: {str(e).splitlines()[0]}") from e
        await asyncio.sleep(2 ** attempt)


async def call_with_retry(fn: Callable[[], Awaitable[Any]], on_wasted: Callable[[float], None] = lambda _: None) -> Any:
    """Retries transient API errors with backoff, and one malformed output (its cost is still reported)."""
    schema_retries = 0
    attempt = 0
    while True:
        try:
            return await fn()
        except SchemaError as e:
            if schema_retries < 1:
                schema_retries += 1
                on_wasted(e.usage["costUsd"])
                continue
            raise
        except Exception as e:
            if attempt >= 3 or not is_retryable(e):
                raise
            await asyncio.sleep(2 * 2 ** attempt)
            attempt += 1
