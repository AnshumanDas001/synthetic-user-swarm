"""Orchestrator and swarm scheduler. Expands a study into sessions (persona x task x repetition), runs each as a
durable unit of work with isolation, politeness, budgets and infra-error retries, and streams every step to the
event bus. Analysis runs incrementally as sessions finish so issues form live."""
from __future__ import annotations

import asyncio
import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional

import httpx

from .analysis.pipeline import analyse_session, issue_summary, synthesize_study
from .analysis.signals import detect_signals
from .config import config, multi_user
from .llm.client import preflight
from .models import TERMINAL_STATUSES, PersonaCard, ScriptStep, StudySpec, TaskSpec
from .personas.generator import generate_personas
from .personas.library import dedupe_personas, load_curated_personas, resolve_curated, seeded_personas, stratified_sample
from .personas.profiles import action_profile, context_options, is_mobile, perception_profile, persona_budget
from .runtime.agent import COST_CAP_DETAIL, FatalError, InfraError, goto_with_backoff, run_agent
from .runtime.netguard import assert_url_safe, url_is_safe
from .runtime.robots import fetch_robots
from .runtime.sandbox import BrowserPool, Sandbox, open_sandbox
from .store.blobs import BlobStore
from .store.db import Db
from .store.events import EventBus
from .util import host_of, log, new_id, now_ms

MAX_ATTEMPTS = 3
LEASE_MS = 60_000


class StudyBusyError(Exception):
    pass


@dataclass
class SwarmDeps:
    db: Db
    blobs: BlobStore
    bus: EventBus
    pool: BrowserPool


def create_deps(db: Optional[Db] = None) -> SwarmDeps:
    db = db or Db()
    return SwarmDeps(db=db, blobs=BlobStore(), bus=EventBus(db), pool=BrowserPool())


# ---------------------------------------------------------------- plan

async def plan_study(deps: SwarmDeps, raw_spec: Any, owner_id: Optional[str] = None, key_source: str = "platform") -> str:
    spec = raw_spec if isinstance(raw_spec, StudySpec) else StudySpec.model_validate(raw_spec)
    host = host_of(spec.target)
    if not any(host == d or host.endswith(f".{d}") for d in spec.allowed_domains):
        raise ValueError(f'target_url host "{host}" is not in allowed_domains')
    if multi_user():
        # Hosted mode: every URL a study names must be public http(s); no server files as persona seeds.
        await assert_url_safe(spec.target, "target_url")
        if spec.reset_url:
            await assert_url_safe(spec.reset_url, "reset_url")
        for t in spec.tasks:
            if t.start_url:
                await assert_url_safe(t.start_url, f"start_url of task {t.id}")
            for st in (t.auth or []) + (t.setup or []):
                if st.goto:
                    await assert_url_safe(st.goto, f"setup step of task {t.id}")
        if spec.personas.seeded_from:
            raise ValueError("seeded_from is not available on the hosted service")
    study_id = new_id("study")
    cards = await _resolve_personas(spec)
    deps.db.insert_study(study_id, spec, owner_id, key_source)
    for card in cards:
        deps.db.insert_persona(study_id, card, perception_profile(card), action_profile(card),
                               persona_budget(card, spec.budget.max_steps, spec.budget.wall_clock_minutes, spec.budget.tokens_per_session))
    # Sessions = persona x task x repetition, each repetition with its own seed.
    for task in spec.tasks:
        for card in cards:
            for rep in range(spec.budget.repetitions):
                deps.db.insert_session({"id": new_id("ses"), "studyId": study_id, "taskId": task.id, "personaId": card.id,
                                        "repetition": rep, "seed": spec.seed * 1000 + rep})
    n = len(cards) * len(spec.tasks) * spec.budget.repetitions
    log("plan", f"{study_id}: {len(cards)} personas x {len(spec.tasks)} tasks x {spec.budget.repetitions} reps = {n} sessions")
    return study_id


async def _resolve_personas(spec: StudySpec) -> list[PersonaCard]:
    library = load_curated_personas()
    cards = list(resolve_curated(spec.personas, library))
    if not spec.personas.include and (spec.personas.generate or spec.personas.seeded_from):
        cards = []
    for g in spec.personas.generate:
        cards += (await generate_personas(g.segment, g.count, spec.seed))[0]
    if spec.personas.seeded_from:
        cards += seeded_personas(spec.personas.seeded_from, spec.personas.size or 6, spec.seed)
    cards = dedupe_personas(cards)
    if spec.personas.size:
        cards = stratified_sample(cards, spec.personas.size, spec.personas.mobile_share, spec.seed)
    if not cards:
        raise ValueError("persona mix resolved to zero personas")
    return cards


# ---------------------------------------------------------------- run

async def run_study(deps: SwarmDeps, study_id: str, only_analyse: bool = False, llm_merge: bool = True,
                    stop: Optional[asyncio.Event] = None) -> None:
    db = deps.db
    study = db.study(study_id)
    if not study:
        raise ValueError(f"no study {study_id}")
    spec = StudySpec.model_validate(study["spec"])
    tasks = {t.id: t for t in db.tasks(study_id)}
    personas = {p.id: p for p in db.personas(study_id)}

    # Credit guard: the effective cap is the study's cap or the credit left above the reserve, whichever is lower,
    # counting what this study already spent (a resumed study keeps its earlier spend).
    cap = spec.budget.cost_cap_usd
    if not only_analyse and config.model_mode == "live":
        credits = await preflight([config.models.step, config.models.escalation, config.models.critic])
        rem = credits["remainingUsd"]
        if rem is not None:
            spent = study["costUsd"]
            cap = min(cap, spent + rem - config.credit_reserve_usd)
            log("credits", f"${rem:.2f} OpenRouter credit left; this study may spend up to ${cap - spent:.2f} more "
                           f"(cap ${spec.budget.cost_cap_usd}, reserve ${config.credit_reserve_usd})")
    robots = await fetch_robots(spec.target) if spec.respect_robots else None
    if robots and robots["disallow"]:
        log("robots", f"honouring robots.txt for {robots['host']}: staying out of {', '.join(robots['disallow'])}")

    # One runner per study, across processes: hold a lease and renew it while working. A study whose runner died
    # (lease expired) can be resumed; one that is actively running cannot be picked up twice.
    runner = f"{os.getpid()}:{new_id('run')}"
    if not db.acquire_study_lease(study_id, runner, LEASE_MS):
        raise StudyBusyError(f"study {study_id} is already being run by another process")

    async def renew():
        while True:
            await asyncio.sleep(LEASE_MS / 3000)
            db.acquire_study_lease(study_id, runner, LEASE_MS)

    renewer = asyncio.create_task(renew())
    try:
        await _run_leased(deps, study_id, spec, tasks, personas, cap, robots, only_analyse, llm_merge, stop)
    finally:
        renewer.cancel()
        db.release_study_lease(study_id, runner)


async def _run_leased(deps: SwarmDeps, study_id: str, spec: StudySpec, tasks: dict[str, TaskSpec], personas: dict[str, PersonaCard],
                      cap: float, robots: Optional[dict], only_analyse: bool, llm_merge: bool, stop: Optional[asyncio.Event]) -> None:
    db, bus = deps.db, deps.bus
    # Resume: sessions left mid-flight by a crashed runner go back on the queue; their recorded steps are kept.
    for s in db.sessions(study_id):
        if s["status"] in ("provisioning", "running"):
            db.update_session(s["id"], status="queued")

    db.set_study_status(study_id, "running")
    bus.publish(study_id, "study.started", {
        "name": spec.name, "targetUrl": spec.target,
        "sessions": [session_info(s, personas[s["personaId"]]) for s in db.sessions(study_id)],
        "tasks": [{"id": t.id, "goal": t.goal} for t in tasks.values()],
    })

    if not only_analyse:
        await deps.pool.warm()
        queue = [s for s in db.sessions(study_id) if s["status"] == "queued"]
        concurrency = min(spec.budget.concurrency, config.per_domain_concurrency)
        state = {"stopped": False, "fatal": None}
        synth_lock = asyncio.Lock()
        synth_tasks: list[asyncio.Task] = []

        async def synth():
            async with synth_lock:
                try:
                    await synthesize_study(db, study_id, llm_merge=False, bus=bus)
                except Exception:
                    pass

        async def worker():
            while True:
                if (stop and stop.is_set()) or state["fatal"]:
                    return
                if not queue:
                    return
                nxt = queue.pop(0)
                # Claim atomically: never run a session another worker already took.
                if not db.claim_session(nxt["id"]):
                    continue
                # Hard per-study cost cap: stop scheduling new sessions once reached.
                if db.study(study_id)["costUsd"] >= cap:
                    db.update_session(nxt["id"], status="queued")
                    if not state["stopped"]:
                        bus.publish(study_id, "log", {"level": "warn", "message": f"cost cap ${cap:.2f} reached; no new sessions scheduled"})
                    state["stopped"] = True
                    return
                r = await _run_session_with_retries(deps, study_id, nxt["id"], tasks[nxt["taskId"]], personas[nxt["personaId"]], spec, cap, robots)
                if r == "fatal":
                    state["fatal"] = (db.session(nxt["id"]) or {}).get("outcomeDetail") or "fatal error"
                    bus.publish(study_id, "log", {"level": "error", "message": state["fatal"]})
                    log("orchestrator", f"stopping study: {state['fatal']}")
                    return
                # Incremental analysis so issues appear and merge live as sessions finish.
                try:
                    await analyse_session(db, deps.blobs, nxt["id"])
                    synth_tasks.append(asyncio.create_task(synth()))
                except Exception as e:
                    log("analyse", f"session {nxt['id']} analysis failed: {e}")

        await asyncio.gather(*(worker() for _ in range(concurrency)))
        if synth_tasks:
            await asyncio.gather(*synth_tasks)

    # Final analysis pass over anything not yet analysed, then synthesis with the LLM merge pass.
    for s in db.sessions(study_id):
        if s["status"] in TERMINAL_STATUSES and s["status"] != "analysed":
            try:
                await analyse_session(db, deps.blobs, s["id"])
            except Exception as e:
                log("analyse", f"{s['id']}: {e}")
    issues = await synthesize_study(db, study_id, llm_merge=llm_merge, bus=bus)
    db.set_study_status(study_id, "stopped" if stop and stop.is_set() else "complete")
    bus.publish(study_id, "study.finished", {"issues": [issue_summary(i) for i in issues], "costUsd": db.study(study_id)["costUsd"]})


def session_info(s: dict, card: PersonaCard) -> dict:
    return {"id": s["id"], "taskId": s["taskId"], "personaId": s["personaId"], "personaName": card.name, "archetype": card.archetype,
            "repetition": s["repetition"], "status": s["status"], "mobile": is_mobile(card), "viewport": context_options(card, "")["viewport"]}


async def _run_session_with_retries(deps: SwarmDeps, study_id: str, session_id: str, task: TaskSpec, card: PersonaCard, spec: StudySpec,
                                    cap: float, robots: Optional[dict]) -> str:
    db, bus = deps.db, deps.bus
    while True:
        row = db.session(session_id)
        attempt = row["attempts"] + 1
        db.update_session(session_id, status="provisioning", attempts=attempt, startedAt=row["startedAt"] or now_ms())
        bus.publish(study_id, "session.status", {"sessionId": session_id, "status": "provisioning", "attempt": attempt})
        result = await _run_session_once(deps, study_id, session_id, task, card, spec, cap, robots)
        if result == "ok":
            return "ok"
        # Infra failures are retried and never counted as usability issues.
        if attempt >= MAX_ATTEMPTS or result.get("fatal") or result.get("noRetry"):
            db.update_session(session_id, status="infra_error", outcome="infra_error", outcomeDetail=result["error"], endedAt=now_ms())
            bus.publish(study_id, "session.status", {"sessionId": session_id, "status": "infra_error", "detail": result["error"]})
            return "fatal" if result.get("fatal") else "ok"
        log("orchestrator", f"{session_id} infra error (attempt {attempt}): {result['error']}; retrying")
        await asyncio.sleep(1.5 * attempt)


def _js(v: Any) -> str:
    return json.dumps(v, separators=(",", ":"), ensure_ascii=False)


async def _run_session_once(deps: SwarmDeps, study_id: str, session_id: str, task: TaskSpec, card: PersonaCard, spec: StudySpec,
                            cap: float, robots: Optional[dict]):
    db, blobs, bus, pool = deps.db, deps.blobs, deps.bus, deps.pool
    sandbox: Optional[Sandbox] = None
    try:
        # Determinism: reset site state between sessions (seeded accounts, emptied carts).
        if spec.reset_url and await url_is_safe(spec.reset_url):
            try:
                async with httpx.AsyncClient(timeout=15, follow_redirects=False) as c:
                    await c.post(spec.reset_url)
            except httpx.HTTPError:
                pass

        sandbox = await open_sandbox(pool, card, spec.allowed_domains, robots)
        start_url = task.start_url or spec.target

        # Auth outside the model: scripted login with secrets from the vault (env vars). The LLM never sees them.
        if task.auth or task.setup:
            await run_script_steps(sandbox, (task.auth or []) + (task.setup or []))

        db.update_session(session_id, status="running")
        bus.publish(study_id, "session.status", {"sessionId": session_id, "status": "running"})
        resume_from = db.steps(session_id)
        budget = persona_budget(card, spec.budget.max_steps, spec.budget.wall_clock_minutes, spec.budget.tokens_per_session)
        session_steps = list(resume_from)
        totals = {"cost": sum(x["costUsd"] for x in resume_from), "tokens": sum(x["tokensIn"] + x["tokensOut"] for x in resume_from)}
        seen_signals = {s["id"] for s in detect_signals(session_steps, None)}

        class Hooks:
            async def on_step(self, step: dict, view: dict) -> None:
                nonlocal seen_signals
                # Immutable step record lands before the next action runs.
                db.insert_step(step)
                session_steps.append(step)
                totals["cost"] += step["costUsd"]
                totals["tokens"] += step["tokensIn"] + step["tokensOut"]
                study_cost = db.add_study_cost(study_id, step["costUsd"])
                db.update_session(session_id, stepCount=len(session_steps), cost=totals["cost"], tokens=totals["tokens"],
                                  estHumanMs=sum(x["estHumanMs"] for x in session_steps))
                a = step["artifacts"]
                bus.publish(study_id, "session.step", {
                    "sessionId": session_id, "idx": step["idx"], "stepId": step["id"], "url": step["url"], "pagePath": step["pagePath"],
                    "title": step["title"], "thinkAloud": step["thinkAloud"], "action": step["action"],
                    "target": (step.get("target") or {}).get("name"), "frustration": step["frustration"], "confidence": step["confidence"],
                    "expectation": step["expectation"]["says"], "expectationMet": step["observation"].get("expectationMet"),
                    "shot": a.get("before_marked") or a.get("before"), "clean": a.get("before"), "after": a.get("after"),
                    "costUsd": step["costUsd"], "elements": len(view["elements"]),
                })
                bus.publish(study_id, "study.cost", {"costUsd": study_cost})
                # Live signals for the journey map and focus view.
                sigs = detect_signals(session_steps, None)
                for s in sigs:
                    if s["id"] in seen_signals:
                        continue
                    page = next((x["pagePath"] for x in session_steps if x["id"] == s["stepId"]), None)
                    bus.publish(study_id, "session.signal", {"sessionId": session_id, "stepId": s["stepId"], "type": s["type"], "details": s["details"], "pagePath": page})
                seen_signals = {s["id"] for s in sigs}

            def on_audit(self, step: dict, violations: list) -> None:
                db.upsert_audit(study_id, step["pagePath"], session_id, step["id"], violations)

            def cost_guard(self) -> bool:
                return db.study(study_id)["costUsd"] < cap

        result = await run_agent(session_id=session_id, study_id=study_id, card=card, task=task, start_url=start_url,
                                 perception=perception_profile(card), action_profile=action_profile(card), budget=budget,
                                 sandbox=sandbox, blobs=blobs, hooks=Hooks(), resume_from=resume_from, robots=robots)
        end = result["end"]

        # Session-level evidence: rrweb stream, console, network (HAR-like, sliced by step id), Playwright trace.
        try:
            await sandbox.page.wait_for_timeout(500)
        except Exception:
            pass
        prefix = f"{study_id}/{session_id}/session"
        artifacts = {
            "rrweb": blobs.put(prefix, _js(sandbox.rrweb), "json"),
            "console": blobs.put(prefix, _js(sandbox.console), "json"),
            "network": blobs.put(prefix, _js(sandbox.network), "json"),
        }
        if sandbox.blocked_requests:
            artifacts["blocked"] = blobs.put(prefix, _js(list(dict.fromkeys(sandbox.blocked_requests))), "json")
        await sandbox.close()
        if Path(sandbox.trace_path).exists():
            artifacts["trace"] = blobs.put(prefix, Path(sandbox.trace_path).read_bytes(), "zip")
        sandbox = None

        # The cost cap is a budget decision, not a fault: no retry.
        if end["status"] == "infra_error":
            return {"error": end["detail"], "noRetry": end["detail"] == COST_CAP_DETAIL}
        db.update_session(session_id, status=end["status"], outcome=end["status"], outcomeDetail=end["detail"], endedAt=now_ms(), artifacts=artifacts)
        bus.publish(study_id, "session.status", {"sessionId": session_id, "status": end["status"], "detail": end["detail"]})
        return "ok"
    except Exception as e:
        msg = str(e) if isinstance(e, (InfraError, FatalError)) else f"{type(e).__name__}: {str(e).splitlines()[0] if str(e) else ''}"
        return {"error": msg, "fatal": isinstance(e, FatalError)}
    finally:
        if sandbox:
            await sandbox.close()


async def run_script_steps(sandbox: Sandbox, steps: list[ScriptStep]) -> None:
    page = sandbox.page
    for step in steps:
        if step.goto:
            await goto_with_backoff(page, step.goto)
        if step.fill:
            value = os.environ.get(step.fill.secret) if step.fill.secret else step.fill.value
            if value is None:
                raise InfraError(f"setup value for {step.fill.selector} is missing (secret {step.fill.secret or '?'} not set)")
            await page.fill(step.fill.selector, value)
        if step.click:
            await page.click(step.click, timeout=10_000)
        if step.wait_for_url:
            import re
            await page.wait_for_url(re.compile(step.wait_for_url), timeout=15_000)
        if step.wait_ms:
            await page.wait_for_timeout(step.wait_ms)
