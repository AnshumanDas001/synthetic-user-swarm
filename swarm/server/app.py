"""API + live dashboard server (FastAPI). The dashboard and the report read the same evidence store, so what the
audience sees live is exactly what the report cites. Events stream over Server-Sent Events. In hosted mode (Google
sign-in) every study belongs to a user: people see only their own work, get one free run on the platform's key, and
can then run on their own OpenRouter key."""
from __future__ import annotations

import asyncio
import dataclasses
import json
import math
import os
import re
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Optional

import yaml
from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse, RedirectResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import ValidationError

from ..config import config, multi_user
from ..crypto import decrypt, encrypt
from ..llm.client import LlmHttpError, credits_remaining, with_api_key
from ..llm.estimate import estimate_study
from ..models import StudySpec
from ..orchestrator import StudyBusyError, create_deps, plan_study, run_study
from ..personas.library import load_curated_personas
from ..personas.profiles import is_mobile
from ..report.data import build_report_data
from ..report.diff import diff_studies
from ..report.html import build_report
from ..report.integrations import export_issue
from ..runtime.domains import discover_domains
from ..runtime.netguard import assert_url_safe
from ..store.accounts import create_account_store, today
from ..util import log, now_ms
from .auth import auth_enabled, auth_mode, current_user, install_auth

WEB = Path(__file__).resolve().parent.parent / "web"
VENDOR = Path(__file__).resolve().parent.parent / "vendor"
STUDY_PATH = re.compile(r"^/(?:api/studies|reports|replay|blobs)/(study_[a-f0-9]+)")


class HttpError(Exception):
    def __init__(self, status: int, message: str, code: Optional[str] = None):
        super().__init__(message)
        self.status, self.code = status, code


def _err(status: int, message: str, code: Optional[str] = None) -> JSONResponse:
    return JSONResponse({"error": message, **({"code": code} if code else {})}, status_code=status)


def _validation_message(e: ValidationError) -> str:
    return "; ".join(f"{'.'.join(str(p) for p in x['loc'])}: {x['msg']}" for x in e.errors()[:3])


def create_app() -> FastAPI:
    deps = create_deps()
    db, bus, blobs = deps.db, deps.bus, deps.blobs
    accounts = create_account_store()
    running: dict[str, asyncio.Event] = {}
    tasks: set[asyncio.Task] = set()
    state = {"reserved_free_usd": 0.0}
    discovering: dict[str, float] = {}

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        await accounts.init()
        shop = None
        if config.demo_shop:
            # The bundled demo shop, so hosted users have a safe site to try the swarm on.
            import uvicorn
            from demo_shop.app import app as shop_app
            shop = uvicorn.Server(uvicorn.Config(shop_app, host="127.0.0.1", port=config.demo_shop_port, log_level="warning"))
            shop.install_signal_handlers = lambda: None  # type: ignore[method-assign]
            tasks.add(asyncio.create_task(shop.serve()))
        # Pre-warm the browser pool so tiles light up the moment Launch is pressed.
        warm = asyncio.create_task(deps.pool.warm())
        warm.add_done_callback(lambda t: t.exception() and log("server", f"browser pre-warm failed: {t.exception()}"))
        # Resume only studies whose runner died (lease expired); a study another process is running is left alone.
        for s in db.studies():
            if s["status"] != "running":
                continue
            lease = db.study_lease(s["id"])
            if lease["runner"] and lease["leaseUntil"] > now_ms():
                log("server", f"study {s['id']} is being run by another process ({lease['runner']}); following it live")
                continue
            log("server", f"resuming study {s['id']}")
            start_run(s["id"])
        log("server", f"dashboard ready (auth: {auth_mode()}; accounts: {'postgres' if config.database_url else 'sqlite'}; model mode: {config.model_mode})")
        yield
        for ev in running.values():
            ev.set()
        if shop:
            shop.should_exit = True
        await deps.pool.close()
        await accounts.close()

    app = FastAPI(title="Synthetic User Swarm", lifespan=lifespan, docs_url="/api/docs", redoc_url=None, openapi_url="/api/openapi.json")

    def is_admin(u: dict) -> bool:
        return u["role"] == "admin"

    def can_see(u: dict, study_id: str) -> bool:
        s = db.study(study_id)
        return bool(s) and (is_admin(u) or s["ownerId"] == u["id"])

    def visible_studies(u: dict) -> list[dict]:
        return [s for s in db.studies() if is_admin(u) or s["ownerId"] == u["id"]]

    def free_left(u: dict) -> float:
        return math.inf if is_admin(u) else max(0, config.limits.free_runs - u["freeRunsUsed"])

    # Every route that names a study (API, evidence, reports, replays) checks the caller may see it.
    # Registered before the auth gate, so it runs after it (Starlette runs the last-added middleware first).
    @app.middleware("http")
    async def guard(request: Request, call_next):
        m = STUDY_PATH.match(request.url.path)
        if m and not can_see(current_user(request), m.group(1)):
            return _err(404, "not found")
        return await call_next(request)

    install_auth(app, accounts)

    @app.exception_handler(HttpError)
    async def http_error(_req: Request, e: HttpError):
        return _err(e.status, str(e), e.code)

    @app.exception_handler(ValidationError)
    async def bad_spec(_req: Request, e: ValidationError):
        return _err(400, _validation_message(e))

    @app.exception_handler(ValueError)
    async def bad_value(_req: Request, e: ValueError):
        return _err(400, str(e))

    @app.get("/healthz", include_in_schema=False)
    async def healthz():
        return {"ok": True}

    async def body_json(request: Request) -> Any:
        raw = await request.body()
        if not raw:
            return {}
        if "yaml" in request.headers.get("content-type", "") or request.headers.get("content-type", "").startswith("text/plain"):
            return yaml.safe_load(raw)
        try:
            return json.loads(raw)
        except ValueError as e:
            raise HttpError(400, "body is not valid JSON") from e

    # ---------------- account

    @app.get("/api/me")
    async def me(request: Request):
        u = current_user(request)
        left = free_left(u)
        L = config.limits
        return {
            "mode": auth_mode(), "auth": auth_enabled(),
            "user": {k: u[k] for k in ("id", "name", "email", "picture", "role")},
            "freeRunsLeft": None if left == math.inf else left, "freeRuns": L.free_runs,
            "hasKey": bool(u["apiKeyEnc"]), "keyLast4": u["apiKeyLast4"],
            "limits": {"free": {"sessions": L.free_max_sessions, "steps": L.free_max_steps, "costUsd": L.free_cost_cap_usd}, "ownKeySessions": L.user_max_sessions},
        }

    @app.post("/api/account/key")
    async def save_key(request: Request):
        """Bring your own key: validated against OpenRouter, encrypted at rest, never sent back to the browser."""
        u = current_user(request)
        if not multi_user():
            raise HttpError(400, "Personal keys are for the hosted service; locally, set OPENROUTER_API_KEY in .env.")
        key = str((await body_json(request)).get("key") or "").strip()
        if not re.fullmatch(r"sk-or-[\w-]{20,}", key):
            raise HttpError(400, "That doesn't look like an OpenRouter key (it starts with sk-or-).")
        try:
            with with_api_key(key):
                credit = await credits_remaining()
        except LlmHttpError:
            raise HttpError(400, "OpenRouter rejected this key.")
        except Exception as e:
            raise HttpError(400, f"Could not check the key: {e}")
        await accounts.set_api_key(u["id"], encrypt(key), key[-4:])
        return {"ok": True, "last4": key[-4:], "remainingUsd": credit["remainingUsd"]}

    @app.delete("/api/account/key")
    async def remove_key(request: Request):
        await accounts.set_api_key(current_user(request)["id"], None, None)
        return {"ok": True}

    @app.get("/api/credits")
    async def credits(request: Request):
        """Credit shown in the sidebar: the platform's to admins, your own key's to everyone else."""
        u = current_user(request)
        if config.model_mode != "live":
            return {"mode": config.model_mode, "remainingUsd": None}
        if not is_admin(u):
            if not u["apiKeyEnc"]:
                return {"mode": config.model_mode, "scope": "none", "remainingUsd": None, "freeRunsLeft": free_left(u)}
            try:
                with with_api_key(decrypt(u["apiKeyEnc"])):
                    c = await credits_remaining()
            except Exception:
                c = {"remainingUsd": None}
            return {"mode": config.model_mode, "scope": "own", **c, "reserveUsd": 0}
        try:
            c = await credits_remaining()
        except Exception as e:
            raise HttpError(502, f"Could not read OpenRouter credit: {e}")
        return {"mode": config.model_mode, "scope": "platform", **c, "reserveUsd": config.credit_reserve_usd}

    @app.get("/api/config")
    async def get_config(request: Request):
        u = current_user(request)
        out = {
            "mode": config.model_mode, "models": dataclasses.asdict(config.models), "effort": dataclasses.asdict(config.effort),
            "reserveUsd": config.credit_reserve_usd, "imageMaxWidth": config.model_image_max_width, "perDomainConcurrency": config.per_domain_concurrency,
            "auth": auth_enabled(), "authMode": auth_mode(), "admin": is_admin(u), "limits": config.limits.public(),
            "demoShop": config.demo_shop, "demoShopPort": config.demo_shop_port,
        }
        if is_admin(u):
            e = os.environ
            out.update({
                "dataDir": str(config.data_dir), "host": config.host, "accountsStore": "postgres" if config.database_url else "sqlite",
                "integrations": {
                    "github": bool(e.get("GITHUB_TOKEN") and e.get("GITHUB_REPO")),
                    "jira": bool(e.get("JIRA_BASE_URL") and e.get("JIRA_EMAIL") and e.get("JIRA_API_TOKEN") and e.get("JIRA_PROJECT_KEY")),
                    "linear": bool(e.get("LINEAR_API_KEY") and e.get("LINEAR_TEAM_ID")),
                },
            })
        return out

    # ---------------- studies

    def study_summary(sid: str) -> dict:
        """One row per study for the overview: progress, outcomes, issue counts by severity, cost."""
        s = db.study(sid)
        sessions = db.sessions(sid)
        outcome = lambda x: x["outcome"] or x["status"]  # noqa: E731
        finished = [x for x in sessions if x["status"] not in ("queued", "provisioning", "running")]
        analysable = [x for x in finished if outcome(x) != "infra_error"]
        issues = db.issues(sid)
        sev = lambda lo, hi: sum(1 for i in issues if lo <= i["severity"] < hi)  # noqa: E731
        spec = s["spec"]
        return {
            "id": s["id"], "name": s["name"], "status": s["status"], "costUsd": s["costUsd"], "capUsd": spec["budget"]["cost_cap_usd"],
            "createdAt": s["createdAt"], "finishedAt": s["finishedAt"], "targetUrl": s["targetUrl"],
            "running": s["id"] in running or s["status"] == "running", "keySource": s["keySource"],
            "tasks": [t["id"] for t in spec["tasks"]], "personas": len(db.personas(sid)), "repetitions": spec["budget"]["repetitions"],
            "sessions": len(sessions), "finished": len(finished), "succeeded": sum(1 for x in analysable if outcome(x) == "succeeded"),
            "analysable": len(analysable), "issues": len(issues),
            "severity": {"critical": sev(3.5, 9), "major": sev(2.5, 3.5), "minor": sev(1.5, 2.5), "cosmetic": sev(0, 1.5)},
        }

    @app.get("/api/studies")
    async def list_studies(request: Request):
        return [study_summary(s["id"]) for s in visible_studies(current_user(request))]

    @app.get("/api/search")
    async def search(request: Request, q: str = ""):
        """Command palette search across the caller's studies and issues."""
        q = q.lower().strip()
        out = []
        for st in visible_studies(current_user(request)):
            if not q or q in st["name"].lower() or q in st["targetUrl"].lower():
                out.append({"kind": "study", "title": st["name"], "sub": st["targetUrl"], "href": f"#/study/{st['id']}"})
            if len(q) >= 2:
                for i in db.issues(st["id"]):
                    if q in f"{i['title']} {i['page']} {i['element']}".lower():
                        out.append({"kind": "issue", "title": i["title"], "sub": f"{st['name']} · {i['page']}", "href": f"#/study/{st['id']}/issues/{i['id']}"})
        return out[:30]

    @app.post("/api/estimate")
    async def estimate(request: Request):
        spec = StudySpec.model_validate(await body_json(request))
        count = spec.personas.size or len(spec.personas.include) or len(load_curated_personas())
        return await estimate_study(spec, count)

    @app.post("/api/domains")
    async def domains(request: Request):
        u = current_user(request)
        url = str((await body_json(request)).get("url") or "")
        if not re.match(r"^https?://", url):
            raise HttpError(400, "Enter a full URL starting with http:// or https://")
        await assert_url_safe(url, "The site URL")
        if discovering.get(u["id"], 0) > now_ms():
            raise HttpError(429, "One domain check at a time; try again in a few seconds.")
        discovering[u["id"]] = now_ms() + 30_000
        try:
            return await discover_domains(url)
        finally:
            discovering.pop(u["id"], None)

    # ---------------- launch policy
    # Admins (and local/password mode) use the platform key without limits. Everyone else gets
    # config.limits.free_runs small runs on the platform key, then runs on their own key.

    @app.post("/api/studies", status_code=201)
    async def launch(request: Request):
        u = current_user(request)
        body = await body_json(request) or {}
        use_own_key = bool(body.pop("useOwnKey", False))
        spec = StudySpec.model_validate(body)
        L = config.limits
        if len(running) >= L.max_active_studies and not is_admin(u):
            n = len(running)
            raise HttpError(429, f"The swarm is busy with {n} other {'study' if n == 1 else 'studies'}. Try again in a few minutes.", "busy")
        persona_count = len(spec.personas.include) or len(load_curated_personas())
        sessions = (persona_count + sum(g.count for g in spec.personas.generate)) * len(spec.tasks) * spec.budget.repetitions

        key_source, free_run = "platform", False
        if multi_user() and not is_admin(u):
            if use_own_key or free_left(u) == 0:
                if not u["apiKeyEnc"]:
                    raise HttpError(402, "You've used your free run. Add your OpenRouter API key in Settings to keep going.", "needs_key")
                key_source = "user"
                if sessions > L.user_max_sessions:
                    raise HttpError(400, f"Runs are limited to {L.user_max_sessions} sessions (personas × tasks × repetitions); this one has {sessions}.")
                spec.budget.concurrency = min(spec.budget.concurrency, 3)
            else:
                if spec.personas.generate:
                    raise HttpError(400, "Generated personas need your own API key; pick curated personas for the free run.")
                if sessions > L.free_max_sessions:
                    raise HttpError(400, f"The free run allows up to {L.free_max_sessions} sessions (for example {L.free_max_sessions} personas × 1 task × 1 repetition); "
                                         f"this one has {sessions}.", "free_limit")
                spent = await accounts.platform_spend(today())
                if spent + state["reserved_free_usd"] + L.free_cost_cap_usd > L.platform_daily_cap_usd:
                    raise HttpError(429, "Today's free capacity is used up. Add your own OpenRouter key in Settings, or try again tomorrow.", "daily_cap")
                spec.budget.cost_cap_usd = min(spec.budget.cost_cap_usd, L.free_cost_cap_usd)
                spec.budget.max_steps = min(spec.budget.max_steps or L.free_max_steps, L.free_max_steps)
                spec.budget.concurrency = min(spec.budget.concurrency, 2)
                if not await accounts.consume_free_run(u["id"], L.free_runs):
                    raise HttpError(402, "You've used your free run. Add your OpenRouter API key in Settings to keep going.", "needs_key")
                free_run = True
        try:
            sid = await plan_study(deps, spec, owner_id=u["id"], key_source=key_source)
        except Exception:
            if free_run:
                await accounts.refund_free_run(u["id"])
            raise
        start_run(sid, free_run=free_run)
        return {"id": sid, "keySource": key_source}

    @app.post("/api/studies/{sid}/resume")
    async def resume(sid: str):
        start_run(sid)
        return {"ok": True}

    @app.post("/api/studies/{sid}/stop")
    async def stop(sid: str):
        if sid in running:
            running[sid].set()
        return {"ok": True}

    async def key_for(study_id: str) -> Optional[str]:
        """Runs a study on the right key."""
        s = db.study(study_id)
        if s["keySource"] != "user":
            return None
        owner = await accounts.get_user(s["ownerId"]) if s["ownerId"] else None
        if not owner or not owner["apiKeyEnc"]:
            raise RuntimeError("This study runs on your own OpenRouter key, which has been removed. Add it again in Settings, then resume.")
        return decrypt(owner["apiKeyEnc"])

    def start_run(sid: str, free_run: bool = False) -> None:
        """Free runs reserve their cap against the daily platform budget and record what they actually spent; a free
        run that never started is refunded."""
        if sid in running:
            return
        stop_ev = asyncio.Event()
        running[sid] = stop_ev
        study = db.study(sid)
        platform_free = study["keySource"] == "platform" and multi_user() and study["ownerId"] and study["ownerId"] != "admin"
        cap = study["spec"]["budget"]["cost_cap_usd"]
        if platform_free:
            state["reserved_free_usd"] += cap

        async def go():
            try:
                with with_api_key(await key_for(sid)):
                    await run_study(deps, sid, llm_merge=True, stop=stop_ev)
                    await build_report(deps, sid)
            except StudyBusyError:
                pass
            except Exception as e:
                log("server", f"study {sid} failed: {e}")
                bus.publish(sid, "log", {"level": "error", "message": str(e)})
                db.set_study_status(sid, "stopped")
                if free_run and (db.study(sid) or {}).get("costUsd", 0) == 0 and study["ownerId"]:
                    try:
                        await accounts.refund_free_run(study["ownerId"])
                    except Exception:
                        pass
            finally:
                running.pop(sid, None)
                if platform_free:
                    state["reserved_free_usd"] = max(0.0, state["reserved_free_usd"] - cap)
                    try:
                        await accounts.add_platform_spend(today(), (db.study(sid) or {}).get("costUsd", 0))
                    except Exception:
                        pass

        t = asyncio.create_task(go())
        tasks.add(t)
        t.add_done_callback(tasks.discard)

    @app.get("/api/studies/{sid}/report-data")
    async def report_data(sid: str):
        d = build_report_data(db, sid)
        latest = db.latest_report_version(sid)
        return {**d, "reportUrl": f"/reports/{sid}/v{latest}/index.html" if latest else None}

    @app.get("/api/studies/{sid}")
    async def get_study(sid: str):
        study = db.study(sid)
        personas = db.personas(sid)
        names = {p.id: p.name for p in personas}
        last = {}
        for st in db.last_steps(sid):
            a = st["artifacts"]
            last[st["sessionId"]] = {"idx": st["idx"], "pagePath": st["pagePath"], "thinkAloud": st["thinkAloud"], "frustration": st["frustration"],
                                     "shot": a.get("before_marked") or a.get("before"), "clean": a.get("before"), "action": st["action"],
                                     "target": (st.get("target") or {}).get("name")}
        return {
            "study": study, "tasks": [t.model_dump(mode="json", exclude_none=True) for t in db.tasks(sid)],
            "personas": [{**p.model_dump(mode="json", exclude_none=True), "mobile": is_mobile(p)} for p in personas],
            "sessions": [{**s, "personaName": names.get(s["personaId"])} for s in db.sessions(sid)],
            "issues": db.issues(sid), "running": sid in running or study["status"] == "running",
            "lastSeq": db.last_event_seq(sid), "lastSteps": last,
        }

    @app.get("/api/studies/{sid}/events")
    async def events(sid: str, request: Request, after: Optional[int] = None):
        """Live event stream: replay everything after ?after=seq, then follow."""
        last = {"seq": after if after is not None else int(request.headers.get("last-event-id") or 0)}
        queue: asyncio.Queue = asyncio.Queue()
        off = bus.subscribe(sid, queue.put_nowait)

        def fmt(ev: dict) -> Optional[str]:
            if ev["seq"] <= last["seq"]:
                return None
            last["seq"] = ev["seq"]
            return f"id: {ev['seq']}\nevent: {ev['type']}\ndata: {json.dumps(ev, separators=(',', ':'))}\n\n"

        async def stream():
            try:
                for ev in bus.replay(sid, last["seq"]):
                    if (line := fmt(ev)) is not None:
                        yield line
                idle = 0.0
                while not await request.is_disconnected():
                    try:
                        ev = await asyncio.wait_for(queue.get(), timeout=1.0)
                        if (line := fmt(ev)) is not None:
                            yield line
                        continue
                    except asyncio.TimeoutError:
                        pass
                    # Studies run by another process (the CLI) write the same events table: follow it too.
                    for ev in bus.replay(sid, last["seq"]):
                        if (line := fmt(ev)) is not None:
                            yield line
                    idle += 1
                    if idle >= 15:
                        idle = 0
                        yield ": ping\n\n"
            finally:
                off()

        return StreamingResponse(stream(), media_type="text/event-stream",
                                 headers={"cache-control": "no-cache", "connection": "keep-alive", "x-accel-buffering": "no"})

    def own_session(study_id: str, session_id: str) -> bool:
        s = db.session(session_id)
        return bool(s) and s["studyId"] == study_id

    @app.get("/api/studies/{sid}/issues")
    async def issues(sid: str):
        return db.issues(sid)

    @app.get("/api/studies/{sid}/sessions/{ses}/steps")
    async def session_steps(sid: str, ses: str):
        return db.steps(ses) if own_session(sid, ses) else _err(404, "not found")

    @app.get("/api/studies/{sid}/sessions/{ses}/signals")
    async def session_signals(sid: str, ses: str):
        return db.signals(ses) if own_session(sid, ses) else _err(404, "not found")

    @app.get("/api/studies/{sid}/sessions/{ses}/replay")
    async def session_replay(sid: str, ses: str):
        s = db.session(ses)
        key = s["artifacts"].get("rrweb") if s and s["studyId"] == sid else None
        if not key or not blobs.exists(key):
            return _err(404, "No replay recorded for this session yet.")
        return FileResponse(blobs.path(key), media_type="application/json")

    @app.get("/api/studies/{sid}/steps/{step_id}")
    async def get_step(sid: str, step_id: str):
        st = db.step(step_id)
        return st if st and own_session(sid, st["sessionId"]) else _err(404, "not found")

    @app.get("/api/studies/{sid}/diff/{base}")
    async def diff(sid: str, base: str, request: Request):
        if not can_see(current_user(request), base):
            raise HttpError(404, "not found")
        return diff_studies(db, base, sid)

    @app.post("/api/studies/{sid}/report")
    async def report(sid: str, request: Request):
        body = await body_json(request) or {}
        compare = body.get("compareTo") if body.get("compareTo") and can_see(current_user(request), body["compareTo"]) else None
        r = await build_report(deps, sid, compare_to=compare, pdf=bool(body.get("pdf")))
        return {"url": f"/reports/{sid}/v{r['version']}/index.html", "version": r["version"]}

    @app.post("/api/issues/{issue_id}/export")
    async def export(issue_id: str, request: Request):
        u = current_user(request)
        body = await body_json(request) or {}
        study_id = str(body.get("studyId") or "")
        if not can_see(u, study_id):
            raise HttpError(404, "not found")
        # Only admins may file tickets with the server's integration credentials; others get the ready-made ticket.
        return await export_issue(db, issue_id, body.get("to") or "github", study_id=study_id, dry_run=bool(body.get("dryRun")) or not is_admin(u))

    @app.get("/api/personas")
    async def personas():
        return [{**p.model_dump(mode="json", exclude_none=True), "mobile": is_mobile(p)} for p in load_curated_personas()]

    @app.get("/api/studies/{sid}/spec.yaml")
    async def spec_yaml(sid: str):
        return PlainTextResponse(yaml.safe_dump(db.study(sid)["spec"], sort_keys=False, allow_unicode=True), media_type="text/yaml")

    @app.get("/replay/{sid}/step/{step_id}", include_in_schema=False)
    async def replay_step(sid: str, step_id: str):
        """"Watch it happen": open the session replay at the step's timestamp."""
        st = db.step(step_id)
        if not st or not own_session(sid, st["sessionId"]):
            return PlainTextResponse("step not found", status_code=404)
        key = db.session(st["sessionId"])["artifacts"].get("rrweb")
        if not key:
            return PlainTextResponse("replay not recorded yet (session still running?)", status_code=404)
        first = json.loads(blobs.get(key))
        t = max(0, st["startedAt"] - (first[0]["timestamp"] if first else st["startedAt"]) - 500)
        from urllib.parse import quote
        return RedirectResponse(f"/replay.html?src={quote('/blobs/' + key, safe='')}&t={t}", status_code=302)

    # ---------------- static

    @app.get("/blobs/{key:path}", include_in_schema=False)
    async def blob(key: str):
        try:
            file = blobs.path(key)
        except ValueError:
            return Response(status_code=400)
        if not file.exists():
            return Response(status_code=404)
        return FileResponse(file, headers={"cache-control": "private, max-age=31536000, immutable"})

    (config.data_dir / "reports").mkdir(parents=True, exist_ok=True)
    app.mount("/reports", StaticFiles(directory=config.data_dir / "reports", html=True), name="reports")
    app.mount("/player", StaticFiles(directory=VENDOR / "player"), name="player")
    app.mount("/", StaticFiles(directory=WEB, html=True), name="web")
    return app


def serve(port: Optional[int] = None) -> None:
    import uvicorn
    host = config.host
    # Without a login the dashboard must stay on this machine.
    if host not in ("127.0.0.1", "localhost", "::1") and not auth_enabled():
        raise SystemExit(f"refusing to listen on {host} without a login: set GOOGLE_CLIENT_ID (+ secret) or SWARM_PASSWORD")
    port = port or config.port
    log("server", f"dashboard on http://localhost:{port}  (bound to {host})")
    uvicorn.run(create_app(), host=host, port=port, log_level="warning",
                proxy_headers=multi_user(), forwarded_allow_ips="*" if multi_user() else "127.0.0.1")
