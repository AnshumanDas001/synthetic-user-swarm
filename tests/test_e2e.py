"""End to end against the seeded-defect shop, offline (mock policy + rule-based critic):
plan -> run in parallel browsers -> evidence -> signals -> candidates -> issues -> report."""
import asyncio
import json
from pathlib import Path

from swarm.orchestrator import create_deps, plan_study, run_study
from swarm.report.html import build_report


def test_study_end_to_end(shop, data_dir):
    async def go():
        deps = create_deps()
        try:
            sid = await plan_study(deps, {
                "name": "e2e", "target_url": f"{shop}/", "allowed_domains": ["localhost"], "permission_confirmed": True, "reset_url": f"{shop}/__reset",
                "tasks": [{"id": "buy-gift", "goal": "Buy a birthday present under $40 and have it delivered.",
                           "success": {"mode": "any", "url_pattern": r"/order/KC\d+", "network": {"method": "POST", "url_pattern": "/api/orders", "status": 201}}}],
                "personas": {"include": ["priya-power-user", "asha-68-mobile"]},
                "budget": {"repetitions": 1, "max_steps": 14, "wall_clock_minutes": 3, "concurrency": 2, "cost_cap_usd": 1},
            })
            await run_study(deps, sid, llm_merge=False)
            db, blobs = deps.db, deps.blobs
            sessions = db.sessions(sid)
            assert len(sessions) == 2
            for s in sessions:
                assert s["status"] == "analysed"
                assert s["outcome"] in ("succeeded", "gave_up", "failed", "timed_out")
                assert s["stepCount"] > 0
                # Session-level evidence: rrweb, console, network, trace.
                for k in ("rrweb", "console", "network", "trace"):
                    assert blobs.exists(s["artifacts"].get(k)), k
                assert json.loads(blobs.get(s["artifacts"]["rrweb"])), "rrweb recorded events"
                # Every step wrote its screenshots and element list before the next action.
                for st in db.steps(s["id"]):
                    assert blobs.exists(st["artifacts"].get("before")) and blobs.exists(st["artifacts"].get("elements"))

            # Every issue cites steps that exist.
            issues = db.issues(sid)
            assert issues
            for i in issues:
                assert i["evidenceStepIds"]
                assert all(db.step(x) for x in i["evidenceStepIds"])
                assert 0 <= i["severity"] <= 4

            # The accessibility audit ran.
            assert db.audits(sid)
            r = await build_report(deps, sid)
            html = Path(r["htmlPath"]).read_text()
            assert "Task × persona" in html and "Accessibility appendix" in html
            assert json.loads(Path(r["jsonPath"]).read_text())["coverage"]["sessions"] == 2
        finally:
            await deps.pool.close()

    asyncio.run(go())
