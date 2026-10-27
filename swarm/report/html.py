"""Report generator. Reads top-down from verdict to proof: summary, task x persona matrix, drop-off per task, issue
cards by severity, accessibility appendix, method and limits. Writes a self-contained folder (works from file://)
with the evidence screenshots, rrweb replays and a JSON export for CI."""
from __future__ import annotations

import json
import re
import shutil
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Optional

from ..analysis.severity import severity_label
from ..config import config
from ..util import new_id
from .assets import REPLAY_HTML, REPORT_CSS
from .data import build_report_data

VENDOR = Path(__file__).resolve().parent.parent / "vendor"


async def build_report(deps, study_id: str, compare_to: Optional[str] = None, pdf: bool = False) -> dict:
    data = build_report_data(deps.db, study_id, compare_to)
    version = deps.db.latest_report_version(study_id) + 1
    out = config.data_dir / "reports" / study_id / f"v{version}"
    for sub in ("assets", "replays", "player"):
        (out / sub).mkdir(parents=True, exist_ok=True)

    def asset(key: Optional[str]) -> Optional[str]:
        """Evidence screenshots, copied by content hash."""
        if not key or not deps.blobs.exists(key):
            return None
        name = Path(key).name
        dest = out / "assets" / name
        if not dest.exists():
            shutil.copyfile(deps.blobs.path(key), dest)
        return f"assets/{name}"

    # Replays: rrweb events wrapped as JS so the page works from file:// as well as over HTTP.
    offsets: dict[str, int] = {}
    for s in data["sessions"]:
        key = s["artifacts"].get("rrweb")
        if not key or not deps.blobs.exists(key):
            continue
        events = json.loads(deps.blobs.get(key))
        if not events:
            continue
        offsets[s["id"]] = events[0]["timestamp"]
        (out / "replays" / f"{s['id']}.js").write_text(f"window.__replay = {json.dumps(events, separators=(',', ':'))};")
        trace = s["artifacts"].get("trace")
        if trace and deps.blobs.exists(trace):
            shutil.copyfile(deps.blobs.path(trace), out / "replays" / f"{s['id']}.trace.zip")
    shutil.copyfile(VENDOR / "player" / "index.js", out / "player" / "rrweb-player.js")
    shutil.copyfile(VENDOR / "player" / "style.css", out / "player" / "rrweb-player.css")
    (out / "replay.html").write_text(REPLAY_HTML)

    html = render_report(data, asset, offsets)
    (out / "index.html").write_text(html)
    export = {**{k: v for k, v in data.items() if k != "stepsById"},
              "sessions": [{k: v for k, v in s.items() if k != "artifacts"} for s in data["sessions"]]}
    js = json.dumps(export, indent=2)
    (out / "report.json").write_text(js)

    html_key = deps.blobs.put(f"{study_id}/reports/v{version}", html, "html")
    json_key = deps.blobs.put(f"{study_id}/reports/v{version}", js, "json")
    deps.db.insert_report(new_id("rep"), study_id, version, (data["diff"] or {}).get("comparedTo"), html_key, json_key)
    deps.bus.publish(study_id, "report.ready", {"version": version, "path": f"/reports/{study_id}/v{version}/index.html"})

    pdf_path = None
    if pdf:
        # PDF printed from the same HTML.
        browser = await deps.pool.get()
        page = await browser.new_page()
        await page.goto((out / "index.html").as_uri())
        pdf_path = str(out / "report.pdf")
        await page.pdf(path=pdf_path, format="A4", print_background=True, margin={"top": "14mm", "bottom": "14mm", "left": "12mm", "right": "12mm"})
        await page.close()
    return {"dir": str(out), "htmlPath": str(out / "index.html"), "jsonPath": str(out / "report.json"), "pdfPath": pdf_path, "version": version}


def esc(s: Any) -> str:
    return ("" if s is None else str(s)).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;").replace("'", "&#39;")


def pct(x: Optional[float]) -> str:
    return "–" if x is None else f"{round(x * 100)}%"


def sev(s: float) -> str:
    label = severity_label(s)
    return f'<span class="sev sev-{re.sub(r"\s", "-", label)}">{s:.1f} · {label}</span>'


def human(s: str) -> str:
    return s.replace("_", " ")


def _n(x: float) -> str:
    return str(int(x)) if float(x).is_integer() else f"{x:g}"


def render_report(d: dict, asset: Callable[[Optional[str]], Optional[str]], offsets: dict[str, int]) -> str:
    personas = {p["id"]: p for p in d["personas"]}
    session_persona = {s["id"]: s["personaId"] for s in d["sessions"]}

    def persona_name(pid: str) -> str:
        return personas.get(pid, {}).get("name", pid)

    def replay_link(step: Optional[dict], label: str = "Watch it happen") -> str:
        if not step or step["sessionId"] not in offsets:
            return ""
        t = max(0, step["startedAt"] - offsets[step["sessionId"]] - 500)
        return f'<a class="replay" href="replay.html?session={step["sessionId"]}&t={t}">▶ {esc(label)}</a>'

    cov = d["coverage"]

    # ---------------- summary
    tiles = "".join(
        f'<div class="tile"><div class="big">{pct(t["successRate"])}</div><div>{esc(t["id"])} success</div>'
        f'<div class="muted">{t["sessions"]} sessions{f" · ~{t["medianHumanSec"]}s for a human" if t["medianHumanSec"] else ""}</div></div>'
        for t in d["tasks"])
    major = sum(1 for i in d["issues"] if i["severity"] >= 2.5)
    tiles += (f'<div class="tile"><div class="big">{len(d["issues"])}</div><div>issues</div><div class="muted">{major} major or worse</div></div>'
              f'<div class="tile"><div class="big">${d["study"]["costUsd"]:.2f}</div><div>study cost</div><div class="muted">{cov["steps"]} steps · {cov["tokens"] / 1000:.0f}k tokens</div></div>'
              f'<div class="tile"><div class="big">{cov["analysable"]}/{cov["sessions"]}</div><div>sessions analysed</div>'
              f'<div class="muted">{cov["personas"]} personas × {cov["tasks"]} tasks × {cov["repetitions"]} reps · {cov["infraErrors"]} infra errors excluded</div></div>')
    top = d["issues"][:5]
    top_html = (f'<h3>Top issues</h3><ol class="top">' + "".join(
        f'<li><a href="#{i["id"]}">{esc(i["title"])}</a> {sev(i["severity"])} <span class="muted">{esc(i["reach"]["label"])}</span></li>' for i in top) + "</ol>"
        if top else "<p>No issues survived evidence validation.</p>")
    summary = f'<section id="summary"><h2>Summary</h2><div class="tiles">{tiles}</div>{top_html}{_render_diff(d) if d["diff"] else ""}</section>'

    # ---------------- matrix
    def cell_color(r: Optional[float]) -> str:
        return "var(--na)" if r is None else f"color-mix(in oklab, var(--good) {round(r * 100)}%, var(--bad))"

    head = "".join(
        f'<th title="{esc(p["archetype"])}">{esc(p["name"])}<div class="muted small">{esc(p["device"]["viewport"])}'
        f'{" · SR" if p["accessibility"]["screen_reader"] else " · kbd" if p["accessibility"]["keyboard_only"] else ""}</div></th>' for p in d["personas"])
    cells = {(m["taskId"], m["personaId"]): m for m in d["matrix"]}
    body = ""
    for t in d["tasks"]:
        row = ""
        for p in d["personas"]:
            c = cells[(t["id"], p["id"])]
            row += (f'<td style="background:{cell_color(c["successRate"])}" title="{c["succeeded"]}/{c["sessions"]} succeeded"><b>{pct(c["successRate"])}</b>'
                    f'<div class="small">{_n(c["medianSteps"])} steps · {c["medianHumanSec"]}s</div></td>')
        body += f'<tr><th>{esc(t["id"])}</th>{row}</tr>'
    matrix = ('<section id="matrix"><h2>Task × persona</h2><p class="muted">Success rate per cell, with median steps and the estimated time a real person would take.</p>'
              f'<div class="scroll"><table class="matrix"><thead><tr><th></th>{head}</tr></thead><tbody>{body}</tbody></table></div></section>')

    # ---------------- funnels
    funnels = '<section id="funnels"><h2>Drop-off per task</h2>'
    for f in d["funnels"]:
        stages = ""
        for i, s in enumerate(f["stages"]):
            w = (s["reached"] / f["total"]) * 100 if f["total"] else 0
            prev = f["stages"][i - 1]["reached"] if i else f["total"]
            drop = prev - s["reached"]
            stages += (f'<div class="stage"><code>{esc(s["page"])}</code><div class="bar"><span style="width:{_n(w)}%"></span></div>'
                       f'<div class="num">{s["reached"]}/{f["total"]}{f" <span class=\"drop\">−{drop}</span>" if drop > 0 and i else ""}</div></div>')
        funnels += f'<h3>{esc(f["taskId"])}</h3><div class="funnel">{stages}</div>'
    funnels += "</section>"

    # ---------------- issue cards
    def issue_card(i: dict) -> str:
        ev = [d["stepsById"][sid] for sid in i["evidenceStepIds"] if sid in d["stepsById"]]
        strip = ""
        for st in ev[:3]:
            before, after = asset(st["artifacts"].get("before")), asset(st["artifacts"].get("after"))
            vb = (st.get("target") or {}).get("vbox")
            box = (f'<div class="target" style="left:{_n(vb["x"] / vb["vw"] * 100)}%;top:{_n(vb["y"] / vb["vh"] * 100)}%;'
                   f'width:{_n(vb["width"] / vb["vw"] * 100)}%;height:{_n(vb["height"] / vb["vh"] * 100)}%"></div>') if vb else ""
            t = st.get("target")
            tname = f' “{esc(t["name"] or "unlabeled " + t["role"])}”' if t else ""
            before_html = f'<img src="{before}" alt="before step {st["idx"]}" loading="lazy">{box}' if before else '<div class="noshot">no screenshot (screen reader)</div>'
            after_html = f'<img src="{after}" alt="after step {st["idx"]}" loading="lazy">' if after else ""
            strip += (f'<figure class="pair"><div class="shot">{before_html}<span class="cap">before</span></div>'
                      f'<div class="shot">{after_html}<span class="cap">after</span></div>'
                      f'<figcaption>{esc(persona_name(session_persona.get(st["sessionId"], "")))} · step {st["idx"]} · {esc(st["action"]["type"])}{tname} {replay_link(st)}</figcaption></figure>')
        quotes = "".join(f'<blockquote>“{esc(q["text"])}” {replay_link(d["stepsById"].get(q["stepId"]), "step")}</blockquote>' for q in i["quotes"])
        chips = " ".join(f'<span class="chip">{esc(human(s))}</span>' for s in i["signalTypes"]) or "—"
        review = ' <span class="review">needs human review</span>' if i["needsReview"] else ""
        fix = f'<p class="fix"><b>Suggested fix</b> <span class="muted">(a suggestion)</span>: {esc(i["suggestedFix"])}</p>' if i.get("suggestedFix") else ""
        return (f'<article class="issue" id="{i["id"]}"><header><h3>{esc(i["title"])}</h3><div class="meta">{sev(i["severity"])} '
                f'<span class="conf conf-{i["confidence"]}">{i["confidence"]} confidence</span>{review} <span class="muted">{esc(i["reach"]["label"])}</span></div></header>'
                f'<p>{esc(i["description"])}</p><dl><dt>Where</dt><dd><code>{esc(i["page"])}</code> — {esc(i["element"])}</dd><dt>Heuristic</dt><dd>{esc(human(i["heuristic"]))}</dd>'
                f'<dt>Signals</dt><dd>{chips}</dd><dt>Impact</dt><dd>{esc(human(i["impact"]))}</dd></dl>{quotes}<div class="strip">{strip}</div>{fix}</article>')

    cards = f'<section id="issues"><h2>Issues <span class="muted">({len(d["issues"])}, by severity)</span></h2>{"".join(issue_card(i) for i in d["issues"])}</section>'

    # ---------------- accessibility appendix
    at = ""
    if d["assistiveTech"]:
        at = ('<h3>Screen-reader and keyboard personas</h3><table class="plain"><thead><tr><th>Persona</th><th>Outcome</th><th>Detail</th></tr></thead><tbody>'
              + "".join(f'<tr><td>{esc(a["name"])}</td><td>{esc(a["outcome"])}</td><td>{esc(a["detail"] or "")}</td></tr>' for a in d["assistiveTech"]) + "</tbody></table>")
    axe = "".join(
        f'<h4><code>{esc(p["page"])}</code></h4><table class="plain"><thead><tr><th>Rule</th><th>Impact</th><th>What</th><th>Nodes</th></tr></thead><tbody>'
        + "".join(f'<tr><td><a href="{esc(v["helpUrl"])}">{esc(v["id"])}</a></td><td>{esc(v["impact"])}</td><td>{esc(v["help"])}</td><td>{v["nodes"]}</td></tr>' for v in p["violations"])
        + "</tbody></table>" for p in d["accessibility"]) or "<p>No axe-core violations recorded.</p>"
    a11y = f'<section id="a11y"><h2>Accessibility appendix</h2>{at}<h3>axe-core violations by page</h3>{axe}</section>'

    # ---------------- sessions + method
    rows = ""
    for s in d["sessions"]:
        out = s["outcome"] or s["status"]
        evidence = (f'<a href="replay.html?session={s["id"]}&t=0">replay</a> · <a href="replays/{s["id"]}.trace.zip">trace</a>' if s["id"] in offsets else "—")
        rows += (f'<tr><td>{esc(s["personaName"])}</td><td>{esc(s["taskId"])}</td><td>{s["repetition"] + 1}</td><td><span class="out out-{esc(out)}">{esc(out)}</span>'
                 f'<div class="small muted">{esc(s["outcomeDetail"] or "")}</div></td><td>{s["stepCount"]}</td><td>{round(s["estHumanMs"] / 1000)}s</td>'
                 f'<td>${s["cost"]:.3f}</td><td>{evidence}</td></tr>')
    sessions = ('<section id="sessions"><h2>Sessions</h2><div class="scroll"><table class="plain"><thead><tr><th>Persona</th><th>Task</th><th>Rep</th><th>Outcome</th>'
                f'<th>Steps</th><th>Est. human time</th><th>Cost</th><th>Evidence</th></tr></thead><tbody>{rows}</tbody></table></div></section>')

    m = d["models"]
    method = (f'<section id="method"><h2>Method and limits</h2><p>{cov["personas"]} synthetic personas each attempted {cov["tasks"]} task(s) {cov["repetitions"]} time(s) '
              "with different seeds in fresh, isolated browsers. Traits were enforced in code: viewport, touch and network through the browser context; zoom, colour vision, "
              "skim reading and screen-reader access through perception filters; keyboard-only access through an action filter; patience through hard step and retry caps.</p>"
              f'<p>Models: step <code>{esc(m["step"])}</code>, escalation when stuck <code>{esc(m["escalation"])}</code>, critic <code>{esc(m["critic"])}</code>, '
              f'synthesis <code>{esc(m["synthesis"])}</code> (mode: {esc(d["modelMode"])}). Success was checked independently of the agent\'s claim. Every issue cites recorded '
              "steps; candidates without a signal or verbatim quote behind them were rejected. Time on task is a Keystroke-Level-Model estimate, not LLM latency.</p>"
              "<p><b>What synthetic users cannot tell you:</b> desirability, trust, willingness to pay, or emotional response. Treat this report as a pre-filter for real "
              "user research, not a replacement. Low-confidence issues are marked for human review.</p></section>")

    st = d["study"]
    when = datetime.fromisoformat(d["generatedAt"].replace("Z", "+00:00")).strftime("%d %b %Y, %H:%M UTC")
    build = f' · build <code>{esc(st["buildId"])}</code>' if st.get("buildId") else ""
    return ('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">\n'
            f'<title>{esc(st["name"])} · Swarm report</title><style>{REPORT_CSS}</style></head><body>\n'
            f'<header class="head"><h1>{esc(st["name"])}</h1><p class="muted"><a href="{esc(st["targetUrl"])}">{esc(st["targetUrl"])}</a> · study <code>{esc(st["id"])}</code>{build} · {when} · <a href="report.json">JSON</a></p>\n'
            '<nav><a href="#summary">Summary</a><a href="#matrix">Matrix</a><a href="#funnels">Drop-off</a><a href="#issues">Issues</a><a href="#a11y">Accessibility</a>'
            '<a href="#sessions">Sessions</a><a href="#method">Method</a></nav></header>\n'
            f"<main>{summary}{matrix}{funnels}{cards}{a11y}{sessions}{method}</main></body></html>")


def _render_diff(d: dict) -> str:
    diff = d["diff"]
    counts = " ".join(f'<span class="chip diff-{k}">{v} {k}</span>' for k, v in diff["counts"].items())
    rows = "".join(
        f'<tr><td><span class="chip diff-{r["status"]}">{r["status"]}</span></td>'
        f'<td>{f"<a href=\"#{r["headIssueId"]}\">{esc(r["title"])}</a>" if r["headIssueId"] else esc(r["title"])}</td>'
        f'<td>{"—" if r["status"] == "fixed" else f"{r["severity"]:.1f}"}</td><td>{"—" if r["baseSeverity"] is None else f"{r["baseSeverity"]:.1f}"}</td></tr>'
        for r in diff["rows"])
    return (f'<h3>Run diff vs <code>{esc(diff["comparedTo"])}</code></h3><p>{counts}</p>'
            f'<table class="plain"><thead><tr><th>Status</th><th>Issue</th><th>Severity</th><th>Before</th></tr></thead><tbody>{rows}</tbody></table>')
