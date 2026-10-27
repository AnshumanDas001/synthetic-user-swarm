"""swarm CLI: plan, run, resume, analyse, report, diff, ci, bench, serve, personas, export."""
from __future__ import annotations

import argparse
import asyncio
import json
import signal
import sys
from datetime import datetime, timezone
from pathlib import Path

import yaml

from .analysis.pipeline import analyse_session, synthesize_study
from .analysis.severity import severity_label
from .config import config
from .llm.client import credits_remaining
from .llm.estimate import estimate_study
from .models import StudySpec
from .orchestrator import create_deps, plan_study, run_study
from .personas.generator import generate_personas
from .personas.library import load_curated_personas
from .report.benchmark import score_benchmark
from .report.diff import diff_studies
from .report.html import build_report
from .report.integrations import export_issue
from .runtime.domains import discover_domains

EPILOG = f"""Environment (.env is loaded): OPENROUTER_API_KEY, SWARM_MODEL_MODE=live|mock (currently: {config.model_mode}),
SWARM_STEP_MODEL (currently: {config.models.step}), SWARM_CRITIC_MODEL, SWARM_CREDIT_RESERVE_USD, SWARM_DATA_DIR"""


def load_spec(file: str):
    text = Path(file).read_text()
    return json.loads(text) if file.endswith(".json") else yaml.safe_load(text)


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="swarm", description="Synthetic User Swarm", epilog=EPILOG, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd")
    r = sub.add_parser("run", help="plan + run a study, then write the report")
    r.add_argument("spec"); r.add_argument("--no-merge", action="store_true"); r.add_argument("--pdf", action="store_true")
    sub.add_parser("plan", help="expand a study into sessions; prints the study id").add_argument("spec")
    r = sub.add_parser("resume", help="continue a study after a crash (keeps recorded steps)")
    r.add_argument("study"); r.add_argument("--no-merge", action="store_true")
    r = sub.add_parser("analyse", help="re-run analysis and synthesis on recorded evidence")
    r.add_argument("study"); r.add_argument("--no-merge", action="store_true")
    r = sub.add_parser("report", help="write the HTML/JSON report")
    r.add_argument("study"); r.add_argument("--compare"); r.add_argument("--pdf", action="store_true")
    r = sub.add_parser("diff", help="label issues new / fixed / regressed / unchanged")
    r.add_argument("base"); r.add_argument("head")
    r = sub.add_parser("ci", help="exit 1 when a new issue at or above the severity appears")
    r.add_argument("study"); r.add_argument("--baseline"); r.add_argument("--min-severity", type=float, default=3)
    r = sub.add_parser("bench", help="recall / precision against the demo shop's seeded defects")
    r.add_argument("study"); r.add_argument("--defects"); r.add_argument("--method", choices=["auto", "llm", "keyword"], default="auto")
    r = sub.add_parser("export", help="file an issue in GitHub, Jira or Linear")
    r.add_argument("issue"); r.add_argument("--to", choices=["github", "jira", "linear"], required=True); r.add_argument("--study"); r.add_argument("--dry-run", action="store_true")
    r = sub.add_parser("personas", help="list curated personas, or generate some")
    r.add_argument("--generate"); r.add_argument("--count", type=int, default=4)
    sub.add_parser("studies", help="list studies")
    sub.add_parser("credits", help="OpenRouter credit left on this key")
    sub.add_parser("domains", help="hosts a site contacts, for allowed_domains").add_argument("url")
    sub.add_parser("estimate", help="expected and worst-case cost before running").add_argument("spec")
    r = sub.add_parser("serve", help="live dashboard + API")
    r.add_argument("--port", type=int, default=None)
    sub.add_parser("shop", help="run the demo shop with its seeded defects (PORT, DEFECTS)")
    return p


async def print_summary(deps, study_id: str) -> None:
    sessions = deps.db.sessions(study_id)
    by = lambda st: sum(1 for s in sessions if (s["outcome"] or s["status"]) == st)  # noqa: E731
    study = deps.db.study(study_id)
    print(f"\n{len(sessions)} sessions: {by('succeeded')} succeeded, {by('gave_up')} gave up, {by('failed')} failed, {by('timed_out')} timed out, "
          f"{by('infra_error')} infra errors · cost ${study['costUsd']:.3f}")
    issues = deps.db.issues(study_id)
    print(f"{len(issues)} issues:")
    for i in issues[:15]:
        print(f"  {i['severity']:.2f} {severity_label(i['severity']):<12} {i['confidence']:<6} {i['title']}  [{i['reach']['label']}]")


async def run(a: argparse.Namespace) -> int:
    deps = create_deps()
    try:
        if a.cmd == "plan":
            print(await plan_study(deps, load_spec(a.spec)))
        elif a.cmd == "run":
            sid = await plan_study(deps, load_spec(a.spec))
            print(f"study {sid}  (model mode: {config.model_mode})")
            stop = asyncio.Event()

            def on_sigint():
                print("\nstopping after in-flight sessions…")
                stop.set()

            try:
                asyncio.get_running_loop().add_signal_handler(signal.SIGINT, on_sigint)
            except (NotImplementedError, RuntimeError):
                pass
            await run_study(deps, sid, llm_merge=not a.no_merge, stop=stop)
            await print_summary(deps, sid)
            r = await build_report(deps, sid, compare_to=deps.db.study(sid)["spec"].get("compare_to"), pdf=a.pdf)
            print(f"report: {r['htmlPath']}")
        elif a.cmd == "resume":
            await run_study(deps, a.study, llm_merge=not a.no_merge)
            await print_summary(deps, a.study)
        elif a.cmd == "analyse":
            for s in deps.db.sessions(a.study):
                if s["status"] in ("succeeded", "gave_up", "failed", "timed_out", "analysed"):
                    await analyse_session(deps.db, deps.blobs, s["id"])
            await synthesize_study(deps.db, a.study, llm_merge=not a.no_merge)
            await print_summary(deps, a.study)
        elif a.cmd == "report":
            r = await build_report(deps, a.study, compare_to=a.compare, pdf=a.pdf)
            print(r["htmlPath"])
            if r["pdfPath"]:
                print(r["pdfPath"])
        elif a.cmd == "diff":
            d = diff_studies(deps.db, a.base, a.head)
            for row in d["rows"]:
                print(f"{row['status']:<10} {row['severity']:.2f}  {row['title']}")
            print(json.dumps(d["counts"]))
        elif a.cmd == "ci":
            if a.baseline:
                failing = [r for r in diff_studies(deps.db, a.baseline, a.study)["rows"] if r["status"] in ("new", "regressed") and r["severity"] >= a.min_severity]
            else:
                failing = [{"status": "open", "severity": i["severity"], "title": i["title"]} for i in deps.db.issues(a.study)
                           if i["severity"] >= a.min_severity and i["confidence"] != "low"]
            print(json.dumps({"study": a.study, "baseline": a.baseline, "minSeverity": a.min_severity, "failing": failing}, indent=2))
            return 1 if failing else 0
        elif a.cmd == "bench":
            res = await score_benchmark(deps.db, a.study, a.defects.split(",") if a.defects else None, a.method)
            print(json.dumps(res, indent=2))
        elif a.cmd == "export":
            print(json.dumps(await export_issue(deps.db, a.issue, a.to, study_id=a.study, dry_run=a.dry_run), indent=2))
        elif a.cmd == "personas":
            if a.generate:
                cards, _ = await generate_personas(a.generate, a.count, 42)
                print(yaml.safe_dump([c.model_dump(mode="json", exclude_none=True) for c in cards], sort_keys=False))
            else:
                for p in load_curated_personas():
                    print(f"{p.id:<22} {p.device.viewport:<10} {p.archetype}")
        elif a.cmd == "domains":
            hosts = await discover_domains(a.url)
            for d in hosts:
                print(f"{d['requests']:>5}  {d['host']}")
            print(f"\nallowed_domains: [{', '.join(d['host'] for d in hosts)}]")
            print("Keep only hosts the tasks need (your app, its API, CDN, auth); drop analytics and ad hosts.")
        elif a.cmd == "credits":
            c = await credits_remaining()
            if c["remainingUsd"] is None:
                print(f"used ${c['usedUsd']:.2f} (no limit on this key)")
            else:
                print(f"${c['remainingUsd']:.2f} left of ${c['limitUsd'] or 0:.2f} (used ${c['usedUsd']:.2f}; reserve kept: ${config.credit_reserve_usd})")
        elif a.cmd == "estimate":
            spec = StudySpec.model_validate(load_spec(a.spec))
            e = await estimate_study(spec, spec.personas.size or len(spec.personas.include) or len(load_curated_personas()))
            print(f"{e['sessions']} sessions × ~{e['assumedStepsPerSession']} steps on {e['models']['step']}")
            print(f"expected ≈ ${e['totalUsd']:.2f}  (≈ ${e['perSessionUsd']:.4f}/session, ${e['perStepUsd']:.5f}/step)")
            print(f"worst case (every session hits max steps) ≈ ${e['worstCaseUsd']:.2f}; study cap ${e['capUsd']}")
        elif a.cmd == "studies":
            for s in deps.db.studies():
                when = datetime.fromtimestamp(s["createdAt"] / 1000, timezone.utc).strftime("%Y-%m-%dT%H:%M")
                print(f"{s['id']}  {s['status']:<9} ${s['costUsd']:>6.2f}  {when}  {s['name']}")
        return 0
    finally:
        await deps.pool.close()


def main(argv: list[str] | None = None) -> None:
    a = parser().parse_args(argv)
    if not a.cmd:
        parser().print_help()
        return
    if a.cmd == "serve":
        from .server.app import serve
        serve(a.port)
        return
    if a.cmd == "shop":
        import runpy
        runpy.run_module("demo_shop", run_name="__main__")
        return
    try:
        sys.exit(asyncio.run(run(a)))
    except (ValueError, RuntimeError) as e:
        print(str(e), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
