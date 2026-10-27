// Report generator. Reads top-down from verdict to proof: summary, task × persona matrix, drop-off per task,
// issue cards by severity, accessibility appendix, method and limits. Writes a self-contained folder
// (works from file://) with the evidence screenshots, rrweb replays and a JSON export for CI.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { config } from "../config.js";
import type { SwarmDeps } from "../orchestrator/orchestrator.js";
import { buildReportData, type ReportData } from "./data.js";
import { severityLabel } from "../analysis/severity.js";
import type { Issue, StepRecord } from "../types.js";
import { newId } from "../util/common.js";

const require = createRequire(import.meta.url);

export async function buildReport(deps: SwarmDeps, studyId: string, opts: { compareTo?: string; pdf?: boolean } = {}) {
  const data = buildReportData(deps.db, studyId, opts.compareTo);
  const version = deps.db.latestReportVersion(studyId) + 1;
  const dir = path.join(config.dataDir, "reports", studyId, `v${version}`);
  fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
  fs.mkdirSync(path.join(dir, "replays"), { recursive: true });
  fs.mkdirSync(path.join(dir, "player"), { recursive: true });

  // Evidence screenshots, copied by content hash.
  const asset = (key: string | undefined): string | null => {
    if (!key || !deps.blobs.exists(key)) return null;
    const name = path.basename(key);
    const dest = path.join(dir, "assets", name);
    if (!fs.existsSync(dest)) fs.copyFileSync(deps.blobs.path(key), dest);
    return `assets/${name}`;
  };

  // Replays: rrweb events wrapped as JS so the page works from file:// as well as over HTTP.
  const replayOffsets: Record<string, number> = {};
  for (const s of data.sessions) {
    const key = s.artifacts.rrweb;
    if (!key || !deps.blobs.exists(key)) continue;
    const events = JSON.parse(deps.blobs.get(key).toString()) as { timestamp: number }[];
    if (!events.length) continue;
    replayOffsets[s.id] = events[0].timestamp;
    fs.writeFileSync(path.join(dir, "replays", `${s.id}.js`), `window.__replay = ${JSON.stringify(events)};`);
    if (s.artifacts.trace && deps.blobs.exists(s.artifacts.trace)) fs.copyFileSync(deps.blobs.path(s.artifacts.trace), path.join(dir, "replays", `${s.id}.trace.zip`));
  }
  const playerDir = path.dirname(require.resolve("rrweb-player/dist/index.js"));
  fs.copyFileSync(path.join(playerDir, "index.js"), path.join(dir, "player", "rrweb-player.js"));
  fs.copyFileSync(path.join(playerDir, "style.css"), path.join(dir, "player", "rrweb-player.css"));
  fs.writeFileSync(path.join(dir, "replay.html"), REPLAY_HTML);

  const html = renderReport(data, { asset, replayOffsets });
  fs.writeFileSync(path.join(dir, "index.html"), html);
  const json = JSON.stringify({ ...data, stepsById: undefined, sessions: data.sessions.map(({ artifacts, ...s }) => s) }, null, 2);
  fs.writeFileSync(path.join(dir, "report.json"), json);

  const htmlKey = deps.blobs.put(`${studyId}/reports/v${version}`, html, "html");
  const jsonKey = deps.blobs.put(`${studyId}/reports/v${version}`, json, "json");
  deps.db.insertReport({ id: newId("rep"), studyId, version, comparedTo: data.diff?.comparedTo ?? null, htmlKey, jsonKey });
  deps.bus.publish(studyId, "report.ready", { version, path: `/reports/${studyId}/v${version}/index.html` });

  let pdfPath: string | undefined;
  if (opts.pdf) {
    // PDF printed from the same HTML.
    const browser = await deps.pool.get();
    const page = await browser.newPage();
    await page.goto(`file://${path.join(dir, "index.html")}`);
    pdfPath = path.join(dir, "report.pdf");
    await page.pdf({ path: pdfPath, format: "A4", printBackground: true, margin: { top: "14mm", bottom: "14mm", left: "12mm", right: "12mm" } });
    await page.close();
  }
  return { dir, htmlPath: path.join(dir, "index.html"), jsonPath: path.join(dir, "report.json"), pdfPath, version };
}

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const pct = (x: number | null) => (x === null ? "–" : `${Math.round(x * 100)}%`);
const sev = (s: number) => `<span class="sev sev-${severityLabel(s).replace(/\s/g, "-")}">${s.toFixed(1)} · ${severityLabel(s)}</span>`;
const human = (s: string) => s.replace(/_/g, " ");

export function renderReport(d: ReportData, ctx: { asset: (k?: string) => string | null; replayOffsets: Record<string, number> }): string {
  const personaName = (id: string) => d.personas.find((p) => p.id === id)?.name ?? id;
  const replayLink = (step: StepRecord | undefined, label = "Watch it happen") => {
    if (!step || ctx.replayOffsets[step.sessionId] === undefined) return "";
    const t = Math.max(0, step.startedAt - ctx.replayOffsets[step.sessionId] - 500);
    return `<a class="replay" href="replay.html?session=${step.sessionId}&t=${t}">▶ ${esc(label)}</a>`;
  };

  // ---------------- summary
  const top = d.issues.slice(0, 5);
  const summary = `
  <section id="summary"><h2>Summary</h2>
    <div class="tiles">
      ${d.tasks.map((t) => `<div class="tile"><div class="big">${pct(t.successRate)}</div><div>${esc(t.id)} success</div><div class="muted">${t.sessions} sessions${t.medianHumanSec ? ` · ~${t.medianHumanSec}s for a human` : ""}</div></div>`).join("")}
      <div class="tile"><div class="big">${d.issues.length}</div><div>issues</div><div class="muted">${d.issues.filter((i) => i.severity >= 2.5).length} major or worse</div></div>
      <div class="tile"><div class="big">$${d.study.costUsd.toFixed(2)}</div><div>study cost</div><div class="muted">${d.coverage.steps} steps · ${(d.coverage.tokens / 1000).toFixed(0)}k tokens</div></div>
      <div class="tile"><div class="big">${d.coverage.analysable}/${d.coverage.sessions}</div><div>sessions analysed</div><div class="muted">${d.coverage.personas} personas × ${d.coverage.tasks} tasks × ${d.coverage.repetitions} reps · ${d.coverage.infraErrors} infra errors excluded</div></div>
    </div>
    ${top.length ? `<h3>Top issues</h3><ol class="top">${top.map((i) => `<li><a href="#${i.id}">${esc(i.title)}</a> ${sev(i.severity)} <span class="muted">${esc(i.reach.label)}</span></li>`).join("")}</ol>` : `<p>No issues survived evidence validation.</p>`}
    ${d.diff ? renderDiff(d) : ""}
  </section>`;

  // ---------------- matrix
  const cellColor = (r: number | null) => (r === null ? "var(--na)" : `color-mix(in oklab, var(--good) ${Math.round(r * 100)}%, var(--bad))`);
  const matrix = `
  <section id="matrix"><h2>Task × persona</h2><p class="muted">Success rate per cell, with median steps and the estimated time a real person would take.</p>
  <div class="scroll"><table class="matrix"><thead><tr><th></th>${d.personas.map((p) => `<th title="${esc(p.archetype)}">${esc(p.name)}<div class="muted small">${esc(p.device.viewport)}${p.accessibility.screen_reader ? " · SR" : p.accessibility.keyboard_only ? " · kbd" : ""}</div></th>`).join("")}</tr></thead>
  <tbody>${d.tasks.map((t) => `<tr><th>${esc(t.id)}</th>${d.personas.map((p) => {
    const c = d.matrix.find((m) => m.taskId === t.id && m.personaId === p.id)!;
    return `<td style="background:${cellColor(c.successRate)}" title="${c.succeeded}/${c.sessions} succeeded"><b>${pct(c.successRate)}</b><div class="small">${c.medianSteps} steps · ${c.medianHumanSec}s</div></td>`;
  }).join("")}</tr>`).join("")}</tbody></table></div></section>`;

  // ---------------- funnels
  const funnels = `
  <section id="funnels"><h2>Drop-off per task</h2>
  ${d.funnels.map((f) => `<h3>${esc(f.taskId)}</h3><div class="funnel">${f.stages.map((s, i) => {
    const w = f.total ? (s.reached / f.total) * 100 : 0;
    const prev = i ? f.stages[i - 1].reached : f.total;
    const drop = prev - s.reached;
    return `<div class="stage"><code>${esc(s.page)}</code><div class="bar"><span style="width:${w}%"></span></div><div class="num">${s.reached}/${f.total}${drop > 0 && i ? ` <span class="drop">−${drop}</span>` : ""}</div></div>`;
  }).join("")}</div>`).join("")}</section>`;

  // ---------------- issue cards
  const cards = `<section id="issues"><h2>Issues <span class="muted">(${d.issues.length}, by severity)</span></h2>${d.issues.map((i) => issueCard(i)).join("")}</section>`;

  function issueCard(i: Issue): string {
    const ev = i.evidenceStepIds.map((id) => d.stepsById[id]).filter(Boolean);
    const strip = ev.slice(0, 3).map((st) => {
      const before = ctx.asset(st.artifacts.before);
      const after = ctx.asset(st.artifacts.after);
      const vb = st.target?.vbox;
      const box = vb ? `<div class="target" style="left:${(vb.x / vb.vw) * 100}%;top:${(vb.y / vb.vh) * 100}%;width:${(vb.width / vb.vw) * 100}%;height:${(vb.height / vb.vh) * 100}%"></div>` : "";
      return `<figure class="pair">
        <div class="shot">${before ? `<img src="${before}" alt="before step ${st.idx}" loading="lazy">${box}` : `<div class="noshot">no screenshot (screen reader)</div>`}<span class="cap">before</span></div>
        <div class="shot">${after ? `<img src="${after}" alt="after step ${st.idx}" loading="lazy">` : ""}<span class="cap">after</span></div>
        <figcaption>${esc(personaName(d.sessions.find((s) => s.id === st.sessionId)?.personaId ?? ""))} · step ${st.idx} · ${esc(st.action.type)}${st.target ? ` “${esc(st.target.name || "unlabeled " + st.target.role)}”` : ""} ${replayLink(st)}</figcaption>
      </figure>`;
    }).join("");
    const quotes = i.quotes.map((q) => `<blockquote>“${esc(q.text)}” ${replayLink(d.stepsById[q.stepId], "step")}</blockquote>`).join("");
    return `<article class="issue" id="${i.id}">
      <header><h3>${esc(i.title)}</h3><div class="meta">${sev(i.severity)} <span class="conf conf-${i.confidence}">${i.confidence} confidence</span>${i.needsReview ? ` <span class="review">needs human review</span>` : ""} <span class="muted">${esc(i.reach.label)}</span></div></header>
      <p>${esc(i.description)}</p>
      <dl><dt>Where</dt><dd><code>${esc(i.page)}</code> — ${esc(i.element)}</dd><dt>Heuristic</dt><dd>${esc(human(i.heuristic))}</dd><dt>Signals</dt><dd>${i.signalTypes.map((s) => `<span class="chip">${esc(human(s))}</span>`).join(" ") || "—"}</dd><dt>Impact</dt><dd>${esc(human(i.impact))}</dd></dl>
      ${quotes}
      <div class="strip">${strip}</div>
      ${i.suggestedFix ? `<p class="fix"><b>Suggested fix</b> <span class="muted">(a suggestion)</span>: ${esc(i.suggestedFix)}</p>` : ""}
    </article>`;
  }

  // ---------------- accessibility appendix
  const a11y = `<section id="a11y"><h2>Accessibility appendix</h2>
    ${d.assistiveTech.length ? `<h3>Screen-reader and keyboard personas</h3><table class="plain"><thead><tr><th>Persona</th><th>Outcome</th><th>Detail</th></tr></thead><tbody>${d.assistiveTech.map((a) => `<tr><td>${esc(a.name)}</td><td>${esc(a.outcome)}</td><td>${esc(a.detail ?? "")}</td></tr>`).join("")}</tbody></table>` : ""}
    <h3>axe-core violations by page</h3>
    ${d.accessibility.length ? d.accessibility.map((p) => `<h4><code>${esc(p.page)}</code></h4><table class="plain"><thead><tr><th>Rule</th><th>Impact</th><th>What</th><th>Nodes</th></tr></thead><tbody>${p.violations.map((v) => `<tr><td><a href="${esc(v.helpUrl)}">${esc(v.id)}</a></td><td>${esc(v.impact)}</td><td>${esc(v.help)}</td><td>${v.nodes}</td></tr>`).join("")}</tbody></table>`).join("") : "<p>No axe-core violations recorded.</p>"}
  </section>`;

  // ---------------- sessions + method
  const sessions = `<section id="sessions"><h2>Sessions</h2><div class="scroll"><table class="plain"><thead><tr><th>Persona</th><th>Task</th><th>Rep</th><th>Outcome</th><th>Steps</th><th>Est. human time</th><th>Cost</th><th>Evidence</th></tr></thead><tbody>
    ${d.sessions.map((s) => `<tr><td>${esc(s.personaName)}</td><td>${esc(s.taskId)}</td><td>${s.repetition + 1}</td><td><span class="out out-${esc(s.outcome ?? s.status)}">${esc(s.outcome ?? s.status)}</span><div class="small muted">${esc(s.outcomeDetail ?? "")}</div></td><td>${s.stepCount}</td><td>${Math.round(s.estHumanMs / 1000)}s</td><td>$${s.cost.toFixed(3)}</td><td>${ctx.replayOffsets[s.id] !== undefined ? `<a href="replay.html?session=${s.id}&t=0">replay</a> · <a href="replays/${s.id}.trace.zip">trace</a>` : "—"}</td></tr>`).join("")}
  </tbody></table></div></section>`;

  const method = `<section id="method"><h2>Method and limits</h2>
    <p>${d.coverage.personas} synthetic personas each attempted ${d.coverage.tasks} task(s) ${d.coverage.repetitions} time(s) with different seeds in fresh, isolated browsers. Traits were enforced in code: viewport, touch and network through the browser context; zoom, colour vision, skim reading and screen-reader access through perception filters; keyboard-only access through an action filter; patience through hard step and retry caps.</p>
    <p>Models: step <code>${esc(d.models.step)}</code>, escalation when stuck <code>${esc(d.models.escalation)}</code>, critic <code>${esc(d.models.critic)}</code>, synthesis <code>${esc(d.models.synthesis)}</code> (mode: ${esc(d.modelMode)}). Success was checked independently of the agent's claim. Every issue cites recorded steps; candidates without a signal or verbatim quote behind them were rejected. Time on task is a Keystroke-Level-Model estimate, not LLM latency.</p>
    <p><b>What synthetic users cannot tell you:</b> desirability, trust, willingness to pay, or emotional response. Treat this report as a pre-filter for real user research, not a replacement. Low-confidence issues are marked for human review.</p>
  </section>`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(d.study.name)} · Swarm report</title><style>${REPORT_CSS}</style></head><body>
<header class="head"><h1>${esc(d.study.name)}</h1><p class="muted"><a href="${esc(d.study.targetUrl)}">${esc(d.study.targetUrl)}</a> · study <code>${esc(d.study.id)}</code>${d.study.buildId ? ` · build <code>${esc(d.study.buildId)}</code>` : ""} · ${new Date(d.generatedAt).toLocaleString()} · <a href="report.json">JSON</a></p>
<nav><a href="#summary">Summary</a><a href="#matrix">Matrix</a><a href="#funnels">Drop-off</a><a href="#issues">Issues</a><a href="#a11y">Accessibility</a><a href="#sessions">Sessions</a><a href="#method">Method</a></nav></header>
<main>${summary}${matrix}${funnels}${cards}${a11y}${sessions}${method}</main></body></html>`;
}

function renderDiff(d: ReportData): string {
  const diff = d.diff!;
  return `<h3>Run diff vs <code>${esc(diff.comparedTo)}</code></h3>
  <p>${Object.entries(diff.counts).map(([k, v]) => `<span class="chip diff-${k}">${v} ${k}</span>`).join(" ")}</p>
  <table class="plain"><thead><tr><th>Status</th><th>Issue</th><th>Severity</th><th>Before</th></tr></thead><tbody>
  ${diff.rows.map((r) => `<tr><td><span class="chip diff-${r.status}">${r.status}</span></td><td>${r.headIssueId ? `<a href="#${r.headIssueId}">${esc(r.title)}</a>` : esc(r.title)}</td><td>${r.status === "fixed" ? "—" : r.severity.toFixed(1)}</td><td>${r.baseSeverity?.toFixed(1) ?? "—"}</td></tr>`).join("")}
  </tbody></table>`;
}

const REPORT_CSS = `
:root{--bg:#fbfaf8;--fg:#1c1c1e;--muted:#6b6b70;--card:#fff;--line:#e6e4df;--good:#3f9b5a;--bad:#d1453b;--na:#eee;--accent:#2f5bd3}
@media (prefers-color-scheme: dark){:root{--bg:#141416;--fg:#ececef;--muted:#9a9aa2;--card:#1d1d21;--line:#2e2e34;--na:#2a2a2e;--accent:#7fa0ff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
a{color:var(--accent)}code{font:13px ui-monospace,SFMono-Regular,Menlo,monospace}
.head{padding:24px 16px 8px;max-width:1100px;margin:0 auto}.head h1{margin:0 0 4px;font-size:26px}
.head nav{display:flex;gap:14px;flex-wrap:wrap;margin-top:8px;font-size:14px}main{max-width:1100px;margin:0 auto;padding:0 16px 64px}
section{margin-top:36px}h2{font-size:20px;border-bottom:1px solid var(--line);padding-bottom:6px}.muted{color:var(--muted)}.small{font-size:12px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px}.tile{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px}
.tile .big{font-size:28px;font-weight:650}.top li{margin:4px 0}
.scroll{overflow-x:auto}.matrix{border-collapse:separate;border-spacing:3px}.matrix td{min-width:88px;padding:8px;border-radius:6px;color:#fff;text-align:center;text-shadow:0 1px 1px rgba(0,0,0,.35)}
.matrix th{font-size:13px;font-weight:600;padding:4px;text-align:left}
.funnel .stage{display:grid;grid-template-columns:180px 1fr 90px;gap:10px;align-items:center;margin:4px 0}.bar{background:var(--na);border-radius:4px;height:18px;overflow:hidden}
.bar span{display:block;height:100%;background:var(--accent)}.drop{color:var(--bad);font-weight:600}
.issue{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin:16px 0}.issue h3{margin:0 0 6px;font-size:18px}
.meta{display:flex;gap:8px;flex-wrap:wrap;align-items:center;font-size:13px}
.sev{padding:2px 8px;border-radius:99px;font-weight:600;font-size:12px;color:#fff;background:#888}.sev-catastrophic{background:#a11d2b}.sev-major{background:#d1453b}.sev-minor{background:#d98a1c}.sev-cosmetic{background:#6b8e23}
.conf{padding:2px 8px;border-radius:99px;font-size:12px;border:1px solid var(--line)}.conf-high{border-color:var(--good)}.conf-low{border-color:var(--bad)}
.review{font-size:12px;color:var(--bad);font-weight:600}
dl{display:grid;grid-template-columns:90px 1fr;gap:2px 12px;font-size:14px}dt{color:var(--muted)}dd{margin:0}
.chip{display:inline-block;padding:1px 8px;border-radius:99px;background:var(--na);font-size:12px;margin:1px}
.diff-new{background:#fde2e0;color:#8a1c14}.diff-fixed{background:#dff3e4;color:#1f6b35}.diff-regressed{background:#fbe3c6;color:#7a4a00}
blockquote{margin:8px 0;padding:6px 12px;border-left:3px solid var(--accent);font-style:italic}
.strip{display:flex;gap:12px;overflow-x:auto;padding:8px 0;align-items:flex-start}.pair{margin:0;display:grid;grid-template-columns:1fr 1fr;gap:6px;min-width:420px;max-width:520px;align-items:start}
.pair figcaption{grid-column:1/-1;font-size:12px;color:var(--muted)}.shot{position:relative;border:1px solid var(--line);border-radius:6px;overflow:hidden;background:#fff}
.shot img{display:block;width:100%}.shot .cap{position:absolute;top:4px;left:4px;font-size:11px;background:rgba(0,0,0,.6);color:#fff;padding:0 5px;border-radius:4px}
.target{position:absolute;border:3px solid #ff2d55;border-radius:4px;box-shadow:0 0 0 2000px rgba(0,0,0,.12)}.noshot{padding:30px;text-align:center;color:var(--muted);font-size:12px}
.replay{font-size:12px;white-space:nowrap}.fix{background:var(--na);padding:8px 12px;border-radius:8px;font-size:14px}
table.plain{border-collapse:collapse;width:100%;font-size:14px}table.plain td,table.plain th{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}
.out{font-weight:600}.out-succeeded{color:var(--good)}.out-gave_up,.out-failed,.out-timed_out{color:var(--bad)}
@media print{.replay{display:none}.issue{break-inside:avoid}}
`;

const REPLAY_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Session replay</title>
<link rel="stylesheet" href="player/rrweb-player.css"><style>body{margin:0;font:14px system-ui;background:#111;color:#eee}header{padding:10px 16px}a{color:#9cf}#p{display:flex;justify-content:center;padding:8px}</style></head>
<body><header><a href="index.html">← report</a> · <span id="t"></span></header><div id="p"></div>
<script src="player/rrweb-player.js"></script><script>

// Strip <script> and preload/modulepreload/prefetch links from recorded DOM, so replays never fetch site code.
function sanitizeReplay(events) {
  const drop = (n) => n && n.type === 2 && (n.tagName === "script" || (n.tagName === "link" && /preload|prefetch|modulepreload/i.test(String(n.attributes && n.attributes.rel || ""))));
  const walk = (n) => { if (n && n.childNodes) { n.childNodes = n.childNodes.filter((c) => !drop(c)); n.childNodes.forEach(walk); } };
  for (const e of events) {
    if (e.type === 2 && e.data && e.data.node) walk(e.data.node);
    if (e.type === 3 && e.data && Array.isArray(e.data.adds)) e.data.adds = e.data.adds.filter((a) => !drop(a.node)).map((a) => (walk(a.node), a));
  }
  return events;
}
const q = new URLSearchParams(location.search); const id = q.get('session'); const t = Number(q.get('t') || 0);
document.getElementById('t').textContent = 'session ' + id + (t ? ' · starts at ' + (t/1000).toFixed(1) + 's' : '');
const s = document.createElement('script'); s.src = 'replays/' + id + '.js';
s.onload = () => { sanitizeReplay(window.__replay); const meta = window.__replay.find(e => e.type === 4); const w = Math.min(1100, (meta && meta.data.width) || 1024);
  const player = new rrwebPlayer({ target: document.getElementById('p'), props: { events: window.__replay, width: w, height: Math.round(w * ((meta && meta.data.height) || 768) / ((meta && meta.data.width) || 1024)), autoPlay: false, showController: true } });
  if (t) { player.goto(t, true); } };
document.body.appendChild(s);
</script></body></html>`;
