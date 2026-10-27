// Study workspace: header with progress and actions, and four tabs (Overview, Live, Issues, Sessions).
// One event stream feeds all tabs; the URL carries the tab (#/study/:id/:tab/:item).
import { api } from "../api.js";
import { donut, hbars, OUTCOME_COLORS } from "../charts.js";
import { openReplay, wireZoom } from "../media.js";
import { refreshCredits, setCrumbs } from "../app.js";
import {
  $, $$, avatar, confBadge, drawer, empty, esc, frame, hostPath, human, icon, money, outcomeBar, pct,
  personaTag, secs, sevBadge, sevClass, statusPill, toast,
} from "../ui.js";

const TABS = [["overview", "Overview"], ["live", "Live"], ["issues", "Issues"], ["sessions", "Sessions"], ["report", "Report"]];

export async function render(view, [id, tab = "overview", item]) {
  view.innerHTML = `<div class="skeleton" style="height:110px;margin-bottom:16px"></div><div class="skeleton" style="height:400px"></div>`;
  const snap = await api.study(id);
  const S = {
    id, tab, item, snap,
    personas: new Map(snap.personas.map((p) => [p.id, p])),
    sessions: new Map(snap.sessions.map((s) => [s.id, { ...s, last: snap.lastSteps[s.id] ?? null }])),
    issues: snap.issues,
    pages: [], hot: new Map(), activity: [],
    rd: null, running: snap.running, costUsd: snap.study.costUsd,
  };
  for (const s of S.sessions.values()) if (s.last && !S.pages.includes(s.last.pagePath)) S.pages.push(s.last.pagePath);

  setCrumbs([["Studies", "#/"], [esc(snap.study.name), `#/study/${id}`]]);
  view.innerHTML = `<div id="head"></div>
    <nav class="tabs" aria-label="Study sections">${TABS.map(([k, label]) => `<a href="#/study/${id}/${k}" class="${k === tab ? "active" : ""}" data-tab="${k}">${label}${k === "issues" ? `<span class="count" id="issue-count">${S.issues.length}</span>` : k === "sessions" ? `<span class="count">${S.sessions.size}</span>` : ""}</a>`).join("")}</nav>
    <section id="tab"></section>`;

  renderHead(S);
  await renderTab(S);

  // Live updates from the evidence store.
  const es = new EventSource(`/api/studies/${id}/events?after=${snap.lastSeq}`);
  const on = (type, fn) => es.addEventListener(type, (m) => fn(JSON.parse(m.data).data));
  let pending = false;
  const schedule = () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => { pending = false; renderHead(S); if (S.tab === "live") renderLive(S, true); if (S.tab === "sessions") renderSessions(S); });
  };
  let rdTimer = null;
  const refreshRd = () => { clearTimeout(rdTimer); rdTimer = setTimeout(async () => { if (S.tab === "overview") { S.rd = await api.reportData(id).catch(() => S.rd); renderOverview(S); } }, 1500); };

  on("study.started", () => { S.running = true; schedule(); });
  on("study.finished", () => { S.running = false; S.snap.study.status = "complete"; schedule(); refreshRd(); refreshCredits(); toast("Study finished — the report is ready."); });
  on("study.cost", (d) => { S.costUsd = d.costUsd; schedule(); });
  on("session.status", (d) => {
    const s = S.sessions.get(d.sessionId);
    if (!s) return;
    s.status = d.status;
    if (["succeeded", "gave_up", "failed", "timed_out", "infra_error"].includes(d.status)) { s.outcome = d.status; s.outcomeDetail = d.detail; refreshRd(); }
    schedule();
  });
  on("session.step", (d) => {
    const s = S.sessions.get(d.sessionId);
    if (!s) return;
    s.status = "running";
    s.stepCount = d.idx + 1;
    s.last = { idx: d.idx, pagePath: d.pagePath, thinkAloud: d.thinkAloud, frustration: d.frustration, shot: d.shot, clean: d.clean, action: d.action, target: d.target };
    if (!S.pages.includes(d.pagePath)) S.pages.push(d.pagePath);
    S.activity.unshift({ sessionId: d.sessionId, ...s.last, at: Date.now() });
    S.activity.length = Math.min(S.activity.length, 40);
    schedule();
  });
  on("session.signal", (d) => { if (d.pagePath) S.hot.set(d.pagePath, Date.now()); schedule(); });
  on("issues.updated", async () => {
    S.issues = await api.get(`/api/studies/${id}/issues`).catch(() => S.issues);
    $("#issue-count").textContent = S.issues.length;
    if (S.tab === "live") renderFeed(S);
    refreshRd();
  });
  on("report.ready", () => { S.rd = null; renderHead(S); });
  const tick = setInterval(() => { if (S.tab === "live") renderMap(S); }, 2000);
  return () => { es.close(); clearInterval(tick); clearTimeout(rdTimer); };
}

// ---------------------------------------------------------------- header
function renderHead(S) {
  const st = S.snap.study;
  const sessions = [...S.sessions.values()];
  const finished = sessions.filter((s) => !["queued", "provisioning", "running"].includes(s.status)).length;
  const status = S.running ? "running" : st.status;
  const canResume = !S.running && sessions.some((s) => s.status === "queued");
  $("#head").innerHTML = `
    <div class="study-head">
      <div style="min-width:0">
        <div class="row"><h1>${esc(st.name)}</h1>${statusPill(status)}</div>
        <div class="meta">
          <span>${icon("globe")} <a href="${esc(st.targetUrl)}" target="_blank" rel="noopener">${esc(hostPath(st.targetUrl))}</a></span>
          <span>${icon("users")} ${S.personas.size} personas × ${S.snap.tasks.length} task${S.snap.tasks.length > 1 ? "s" : ""} × ${st.spec.budget.repetitions} reps</span>
          <span>${icon("coins")} <b class="tnum">${money(S.costUsd)}</b> of ${money(st.spec.budget.cost_cap_usd)} cap</span>
        </div>
      </div>
      <div class="row">
        ${S.running ? `<button class="btn danger" id="stop">${icon("stop")}Stop</button>` : ""}
        ${canResume ? `<button class="btn" id="resume">${icon("play")}Resume</button>` : ""}
        <button class="btn" id="report">${icon("refresh")}Build report</button>
        <a class="btn primary" id="open-report" href="#" target="_blank" hidden>${icon("file")}Open report</a>
      </div>
    </div>
    <div class="study-progress">
      ${outcomeBar(sessions)}
      <span class="small muted tnum">${finished}/${sessions.length} sessions</span>
      <div class="legend"><span><i style="background:var(--good)"></i>succeeded</span><span><i style="background:var(--warn)"></i>gave up</span><span><i style="background:var(--bad)"></i>failed</span><span><i style="background:var(--accent)"></i>running</span><span><i style="background:var(--muted)"></i>infra error</span></div>
    </div>`;
  $("#stop")?.addEventListener("click", async () => { await api.stop(S.id); toast("Stopping after in-flight sessions finish."); });
  $("#resume")?.addEventListener("click", async () => { await api.resume(S.id); S.running = true; renderHead(S); toast("Study resumed."); });
  $("#report").addEventListener("click", async (e) => {
    e.currentTarget.disabled = true;
    try { const r = await api.buildReport(S.id); window.open(r.url, "_blank"); } catch (err) { toast(err.message, "bad"); }
    e.currentTarget.disabled = false;
  });
  const showReport = (url) => { const a = $("#open-report"); if (url && a) { a.href = url; a.hidden = false; } };
  if (S.rd?.reportUrl) showReport(S.rd.reportUrl);
  else api.reportData(S.id).then((rd) => { S.rd ??= rd; showReport(rd.reportUrl); }).catch(() => {});
}

async function renderTab(S) {
  if (S.tab === "overview") {
    S.rd ??= await api.reportData(S.id);
    renderOverview(S);
  } else if (S.tab === "live") renderLive(S);
  else if (S.tab === "issues") renderIssues(S);
  else if (S.tab === "report") renderReportTab(S);
  else renderSessions(S);
}

// ---------------------------------------------------------------- overview
function renderOverview(S) {
  const rd = S.rd;
  const el = $("#tab");
  if (!rd) return;
  const issues = S.issues;
  const bySev = (c) => issues.filter((i) => sevClass(i.severity) === c).length;
  const sessions = [...S.sessions.values()];
  el.innerHTML = `
    <div class="grid cols-4" style="margin-bottom:16px">
      ${rd.tasks.map((t) => `<div class="card kpi"><div class="label">${icon("target")}Task · ${esc(t.id)}</div><div class="value tnum">${pct(t.successRate)}</div><div class="sub">${t.sessions} sessions${t.medianHumanSec ? ` · ~${t.medianHumanSec}s for a person` : ""}</div></div>`).join("")}
      <div class="card kpi"><div class="label">${icon("alert")}Issues</div><div class="value tnum">${issues.length}</div>
        <div class="row" style="gap:4px">${["critical", "major", "minor", "cosmetic"].map((c) => (bySev(c) ? `<span class="sev ${c}">${bySev(c)} ${c}</span>` : "")).join("")}</div></div>
      <div class="card kpi"><div class="label">${icon("activity")}Steps recorded</div><div class="value tnum">${rd.coverage.steps.toLocaleString()}</div><div class="sub">${(rd.coverage.tokens / 1e6).toFixed(2)}M tokens · ${rd.coverage.infraErrors} infra errors excluded</div></div>
    </div>
    <div class="grid cols-3" style="margin-bottom:16px;align-items:stretch">
      <div class="card"><div class="card-head"><h2>Outcomes</h2><span class="small muted">${sessions.length} sessions</span></div><div class="card-body">${outcomeDonut(sessions)}</div></div>
      <div class="card"><div class="card-head"><h2>Success by persona</h2><span class="small muted">all tasks</span></div><div class="card-body">${personaBars(S, rd)}</div></div>
      <div class="card"><div class="card-head"><h2>Issues by severity</h2><span class="small muted">${issues.length} total</span></div><div class="card-body">${severityChart(issues)}</div></div>
    </div>
    <div class="grid cols-2" style="align-items:start">
      <div class="card">
        <div class="card-head"><h2>Top issues</h2><a href="#/study/${S.id}/issues" class="small">All ${issues.length} →</a></div>
        ${issues.length ? `<ul class="feed">${issues.slice(0, 6).map((i) => `<li data-issue="${esc(i.id)}"><div class="row" style="justify-content:space-between;flex-wrap:nowrap"><span class="t">${esc(i.title)}</span>${sevBadge(i.severity)}</div><span class="small muted">${esc(i.reach.label)} · ${esc(human(i.heuristic))}</span></li>`).join("")}</ul>`
          : empty("check", "No issues yet", "Issues appear as sessions finish and their evidence is validated.")}
      </div>
      <div class="card">
        <div class="card-head"><h2>Drop-off per task</h2><span class="small muted">sessions reaching each page</span></div>
        <div class="card-body stack">${rd.funnels.map((f) => `<div><h3 style="margin-bottom:10px">${esc(f.taskId)}</h3><div class="funnel">${f.stages.map((s, i) => {
          const prev = i ? f.stages[i - 1].reached : f.total;
          return `<div class="funnel-row"><code title="${esc(s.page)}">${esc(s.page)}</code><div class="funnel-bar"><span style="width:${f.total ? (s.reached / f.total) * 100 : 0}%"></span></div><span class="n">${s.reached}/${f.total}${i && prev - s.reached > 0 ? ` <span class="drop">−${prev - s.reached}</span>` : ""}</span></div>`;
        }).join("") || '<span class="muted small">No steps yet</span>'}</div></div>`).join("")}</div>
      </div>
    </div>
    <div class="card" style="margin-top:16px">
      <div class="card-head"><h2>Task × persona</h2><span class="small muted">success rate · median steps</span></div>
      <div class="card-body table-wrap"><table class="matrix"><thead><tr><th></th>${rd.personas.map((p) => `<th>${esc(p.name)}<small>${esc(personaTag({ ...p, mobile: S.personas.get(p.id)?.mobile }))}</small></th>`).join("")}</tr></thead>
      <tbody>${rd.tasks.map((t) => `<tr><th>${esc(t.id)}</th>${rd.personas.map((p) => {
        const c = rd.matrix.find((m) => m.taskId === t.id && m.personaId === p.id);
        if (!c || c.successRate == null) return `<td class="na">—</td>`;
        return `<td style="background:color-mix(in oklab, #16a34a ${Math.round(c.successRate * 100)}%, #dc2626)" title="${c.succeeded}/${c.sessions} succeeded">${pct(c.successRate)}<small>${c.medianSteps} steps</small></td>`;
      }).join("")}</tr>`).join("")}</tbody></table></div>
    </div>
`;
  $$("[data-issue]", el).forEach((li) => li.addEventListener("click", () => (location.hash = `#/study/${S.id}/issues/${li.dataset.issue}`)));
}

function outcomeDonut(sessions) {
  const o = (s) => s.outcome ?? (["running", "provisioning"].includes(s.status) ? "running" : s.status);
  const keys = [["succeeded", "Succeeded"], ["gave_up", "Gave up"], ["failed", "Failed"], ["timed_out", "Timed out"], ["infra_error", "Infra error"], ["running", "Running"]];
  const parts = keys.map(([k, label]) => ({ label, value: sessions.filter((s) => o(s) === k).length, color: OUTCOME_COLORS[k] })).filter((p) => p.value);
  const done = sessions.filter((s) => s.outcome && s.outcome !== "infra_error");
  const ok = done.filter((s) => s.outcome === "succeeded").length;
  return donut(parts, done.length ? `${Math.round((ok / done.length) * 100)}%` : "—", "succeeded");
}

function personaBars(S, rd) {
  const rows = rd.personas.map((p) => {
    const cells = rd.matrix.filter((m) => m.personaId === p.id && m.sessions);
    const n = cells.reduce((a, c) => a + c.sessions, 0);
    const ok = cells.reduce((a, c) => a + c.succeeded, 0);
    return { label: p.name, title: `${p.name} — ${p.archetype}`, value: n ? ok / n : null, display: n ? `${ok}/${n}` : "—" };
  }).sort((a, b) => (b.value ?? -1) - (a.value ?? -1));
  return hbars(rows);
}

function severityChart(issues) {
  const groups = [["critical", "var(--crit)"], ["major", "var(--bad)"], ["minor", "var(--warn)"], ["cosmetic", "var(--muted)"]].map(([k, c]) => ({ k, c, n: issues.filter((i) => sevClass(i.severity) === k).length }));
  const total = issues.length || 1;
  const conf = ["high", "medium", "low"].map((k) => [k, issues.filter((i) => i.confidence === k).length]);
  return `<div class="sevbar" style="margin:4px 0 14px">${groups.map((g) => (g.n ? `<span style="width:${(g.n / total) * 100}%;background:${g.c}" title="${g.n} ${g.k}"></span>` : "")).join("")}</div>
    ${hbars(groups.map((g) => ({ label: g.k[0].toUpperCase() + g.k.slice(1), value: g.n, display: String(g.n) })), { max: Math.max(1, ...groups.map((g) => g.n)), color: (v) => "var(--accent)" })}
    <div class="row small muted" style="margin-top:14px;gap:12px">${conf.map(([k, n]) => `<span>${n} ${k} confidence</span>`).join("")}</div>`;
}

function outcomeTable(sessions) {
  const o = (s) => s.outcome ?? s.status;
  const groups = ["succeeded", "gave_up", "failed", "timed_out", "infra_error", "running", "queued"].map((k) => [k, sessions.filter((s) => o(s) === k || (k === "running" && s.status === "provisioning"))]);
  return `<div class="row" style="gap:20px">${groups.filter(([, v]) => v.length).map(([k, v]) => `<div>${statusPill(k)} <b class="tnum" style="margin-left:6px">${v.length}</b></div>`).join("")}</div>`;
}

// ---------------------------------------------------------------- live
function mood(s) {
  if (!s.last) return "idle";
  if (["gave_up", "failed", "timed_out"].includes(s.outcome)) return "stuck";
  return s.last.frustration >= 7 ? "stuck" : s.last.frustration >= 4 ? "struggling" : "calm";
}

// The persona's live session, else its latest one with steps.
function personaSession(S, pid) {
  const ss = [...S.sessions.values()].filter((s) => s.personaId === pid);
  return ss.find((s) => s.status === "running" || s.status === "provisioning") ?? [...ss].reverse().find((s) => s.last) ?? ss[0];
}

function renderLive(S, partial = false) {
  const el = $("#tab");
  if (!partial || !$("#wall")) {
    el.innerHTML = `<div class="live-grid">
      <div class="card"><div class="card-head"><h2>Agent wall</h2><span class="small muted">border shows frustration · click a tile to follow that persona</span></div><div class="card-body"><div class="wall" id="wall"></div></div></div>
      <div class="stack">
        <div class="card"><div class="card-head"><h2>Issue feed</h2><span class="pill ${S.running ? "live accent" : ""}"><span class="dot"></span>${S.running ? "forming live" : "final"}</span></div><ul class="feed" id="feed"></ul></div>
        <div class="card"><div class="card-head"><h2>Journey map</h2><span class="small muted">red = signals firing</span></div><div class="card-body tight"><svg id="map" class="map" viewBox="0 0 320 180" role="img" aria-label="Pages visited by agents"></svg></div></div>
        <div class="card"><div class="card-head"><h2>Activity</h2></div><ul class="activity" id="activity"></ul></div>
      </div></div>`;
    renderFeed(S);
  }
  $("#wall").innerHTML = S.snap.personas.map((p) => {
    const s = personaSession(S, p.id);
    const runs = [...S.sessions.values()].filter((x) => x.personaId === p.id);
    const last = s?.last;
    return `<button class="tile ${s ? mood(s) : "idle"}" data-sid="${esc(s?.id ?? "")}" aria-label="Follow ${esc(p.name)}">
      <div class="shot ${p.mobile ? "phone" : ""}" style="${last?.clean ?? last?.shot ? `background-image:url('/blobs/${esc(last.clean ?? last.shot)}')` : ""}"><span class="tag">${s ? statusPill(s.outcome ?? s.status) : ""}</span></div>
      <div class="body">
        <div class="who">${avatar(p.name, p.id)}<div style="min-width:0"><b>${esc(p.name)}</b><div class="what">${esc(personaTag(p))} · ${esc(p.archetype)}</div></div></div>
        <div class="what">${s ? `${esc(s.taskId)} · rep ${s.repetition + 1}${last ? ` · step ${last.idx + 1} · ${esc(last.pagePath)}` : ""}` : ""}</div>
        <div class="bubble">${last ? `“${esc(last.thinkAloud)}”` : '<span class="muted">Waiting to start…</span>'}</div>
        <div class="runs">${runs.map((x) => `<i class="${esc(x.outcome ?? x.status)}" title="${esc(x.taskId)} rep ${x.repetition + 1}: ${esc(x.outcome ?? x.status)}"></i>`).join("")}</div>
      </div></button>`;
  }).join("");
  $$("#wall .tile").forEach((t) => t.addEventListener("click", () => t.dataset.sid && openSession(S, t.dataset.sid)));
  $("#activity").innerHTML = S.activity.length
    ? S.activity.slice(0, 25).map((a) => { const s = S.sessions.get(a.sessionId); const p = S.personas.get(s?.personaId); return `<li>${avatar(p?.name, p?.id)}<div><b>${esc(p?.name)}</b> <span class="muted">${esc(a.action?.type)}${a.target ? ` “${esc(a.target)}”` : ""} · ${esc(a.pagePath)}</span></div></li>`; }).join("")
    : `<li class="muted" style="display:block">Steps stream here while the study runs.</li>`;
  renderMap(S);
}

function renderFeed(S) {
  const feed = $("#feed");
  if (!feed) return;
  feed.innerHTML = S.issues.length
    ? S.issues.slice(0, 10).map((i) => `<li data-issue="${esc(i.id)}"><div class="row" style="justify-content:space-between;flex-wrap:nowrap"><span class="t">${esc(i.title)}</span>${sevBadge(i.severity)}</div><span class="small muted">${esc(i.reach?.label ?? i.reach)}</span></li>`).join("")
    : `<li class="muted" style="cursor:default">Issues appear and merge here as sessions finish.</li>`;
  $$("[data-issue]", feed).forEach((li) => li.addEventListener("click", () => (location.hash = `#/study/${S.id}/issues/${li.dataset.issue}`)));
}

// Pages as nodes in first-visit order; agents as dots on their current page.
function renderMap(S) {
  const svg = $("#map");
  if (!svg) return;
  const pages = S.pages.slice(0, 8);
  if (!pages.length) { svg.innerHTML = `<text x="160" y="94" text-anchor="middle">waiting for the first steps…</text>`; return; }
  const n = pages.length;
  const pos = (i) => ({ x: 26 + (i * 268) / Math.max(n - 1, 1), y: i % 2 ? 112 : 64 });
  const now = Date.now();
  const edges = pages.slice(1).map((_, i) => { const a = pos(i), b = pos(i + 1); return `<line class="edge" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"/>`; }).join("");
  const nodes = pages.map((p, i) => { const { x, y } = pos(i); return `<circle class="node ${now - (S.hot.get(p) ?? 0) < 8000 ? "hot" : ""}" cx="${x}" cy="${y}" r="11"><title>${esc(p)}</title></circle><text x="${x}" y="${y + (i % 2 ? 26 : -18)}" text-anchor="middle">${esc(p.length > 14 ? p.slice(0, 13) + "…" : p)}</text>`; }).join("");
  const dots = [...S.sessions.values()].filter((s) => s.status === "running" && s.last).map((s, k) => {
    const i = pages.indexOf(s.last.pagePath);
    if (i < 0) return "";
    const { x, y } = pos(i);
    const a = k * 2.4;
    return `<circle class="agent" cx="${x + Math.cos(a) * 16}" cy="${y + Math.sin(a) * 16}" r="3.5"><title>${esc(S.personas.get(s.personaId)?.name)}</title></circle>`;
  }).join("");
  svg.innerHTML = edges + nodes + dots;
}

// ---------------------------------------------------------------- issues
function renderIssues(S) {
  const el = $("#tab");
  const f = { sev: "all", q: "" };
  el.innerHTML = `<div class="split">
    <div class="card">
      <div class="filters">
        <div class="seg" id="sevf">${["all", "critical", "major", "minor", "cosmetic"].map((k) => `<button data-k="${k}" class="${k === "all" ? "on" : ""}">${k === "all" ? "All" : k[0].toUpperCase() + k.slice(1)}</button>`).join("")}</div>
        <input class="input" id="q" placeholder="Filter issues" aria-label="Filter issues">
      </div>
      <ul class="issue-list" id="ilist"></ul>
    </div>
    <div class="card" id="idetail"></div>
  </div>`;
  const list = () => S.issues.filter((i) => (f.sev === "all" || sevClass(i.severity) === f.sev) && (!f.q || `${i.title} ${i.page} ${i.element}`.toLowerCase().includes(f.q)));
  const draw = () => {
    const items = list();
    const sel = S.item && items.some((i) => i.id === S.item) ? S.item : items[0]?.id;
    $("#ilist").innerHTML = items.length
      ? items.map((i) => `<li data-id="${esc(i.id)}" class="${i.id === sel ? "sel" : ""}"><span class="t">${esc(i.title)}</span><div class="row" style="gap:6px">${sevBadge(i.severity)}<span class="small muted">${esc(i.reach.label)}</span></div></li>`).join("")
      : `<li class="muted" style="cursor:default">No issues match.</li>`;
    $$("#ilist li[data-id]").forEach((li) => li.addEventListener("click", () => { S.item = li.dataset.id; history.replaceState(null, "", `#/study/${S.id}/issues/${li.dataset.id}`); draw(); }));
    const issue = S.issues.find((i) => i.id === sel);
    if (issue) renderIssueDetail(S, issue);
    else $("#idetail").innerHTML = empty("check", S.issues.length ? "Pick an issue" : "No issues yet", S.issues.length ? "Select an issue to see its evidence." : "Issues appear once sessions finish and their evidence is validated.");
  };
  $$("#sevf button").forEach((b) => b.addEventListener("click", () => { f.sev = b.dataset.k; $$("#sevf button").forEach((x) => x.classList.toggle("on", x === b)); draw(); }));
  $("#q").addEventListener("input", (e) => { f.q = e.target.value.toLowerCase(); draw(); });
  draw();
}

async function renderIssueDetail(S, i) {
  const el = $("#idetail");
  const personaOf = (sessionId) => S.personas.get(S.sessions.get(sessionId)?.personaId);
  el.innerHTML = `<div class="detail">
    <div><div class="row" style="margin-bottom:8px">${sevBadge(i.severity)}${confBadge(i.confidence, i.needsReview)}<span class="pill">${esc(human(i.impact))}</span></div>
      <h2>${esc(i.title)}</h2><p class="muted" style="margin:6px 0 0">${esc(i.reach.label)} · hit by ${i.personaIds.map((p) => esc(S.personas.get(p)?.name ?? p)).join(", ")}</p></div>
    <p style="margin:0;font-size:14.5px">${esc(i.description)}</p>
    <dl class="facts"><dt>Where</dt><dd><code>${esc(i.page)}</code> — ${esc(i.element)}</dd><dt>Heuristic</dt><dd>${esc(human(i.heuristic))}</dd>
      <dt>Signals</dt><dd><div class="row" style="gap:4px">${i.signalTypes.map((s) => `<span class="chip">${esc(human(s))}</span>`).join("") || "—"}</div></dd></dl>
    ${i.quotes.map((q) => `<div class="quote">“${esc(q.text)}”<div class="by"><span data-quote-by="${esc(q.stepId)}">synthetic user</span> · <a href="/replay/${esc(S.id)}/step/${esc(q.stepId)}" target="_blank">${icon("film")} watch it happen</a></div></div>`).join("")}
    <div><h3 style="margin-bottom:10px">Evidence</h3><div class="evidence" id="evidence">${i.evidenceStepIds.map(() => `<div class="ev"><div class="skeleton" style="height:200px"></div></div>`).join("")}</div></div>
    ${i.suggestedFix ? `<div class="fix"><b>Suggested fix</b> <span class="muted small">(a suggestion, not a verdict)</span><div style="margin-top:4px">${esc(i.suggestedFix)}</div></div>` : ""}
    <div class="row"><span class="muted small">Send to</span>
      ${["github", "jira", "linear"].map((t) => `<button class="btn sm" data-export="${t}">${icon("share")}${t === "github" ? "GitHub" : t[0].toUpperCase() + t.slice(1)}</button>`).join("")}
    </div></div>`;
  $$("[data-export]", el).forEach((b) => b.addEventListener("click", () => exportIssue(S, i, b.dataset.export)));

  const quoteIds = i.quotes.map((q) => q.stepId).filter((sid) => !i.evidenceStepIds.includes(sid));
  const [steps, quoteSteps] = await Promise.all([
    Promise.all(i.evidenceStepIds.map((sid) => api.step(S.id, sid).catch(() => null))),
    Promise.all(quoteIds.map((sid) => api.step(S.id, sid).catch(() => null))),
  ]);
  const byId = Object.fromEntries([...steps, ...quoteSteps].filter(Boolean).map((s) => [s.id, s]));
  for (const span of $$("[data-quote-by]", el)) {
    const st = byId[span.dataset.quoteBy];
    const p = st ? personaOf(st.sessionId) : null;
    if (p) {
      span.innerHTML = `${avatar(p.name, p.id)} <b>${esc(p.name)}</b> · ${esc(personaTag(p))} · step ${st.idx + 1}`;
      const a = span.parentElement.querySelector("a");
      if (a) Object.assign(a.dataset, { replay: st.sessionId, at: String(st.startedAt), title: `${p.name} · step ${st.idx + 1}` });
    }
  }
  const ev = $("#evidence");
  if (!ev) return;
  ev.innerHTML = steps.filter(Boolean).map((st) => {
    const p = personaOf(st.sessionId);
    return `<div class="ev"><div class="imgs">${frame(st.artifacts.before, "before", st.target?.vbox)}${frame(st.artifacts.after, "after")}</div>
      <div class="meta"><div class="row" style="gap:8px">${avatar(p?.name, p?.id)}<b>${esc(p?.name)}</b><span class="muted">step ${st.idx + 1} · ${esc(st.action.type)}${st.target ? ` “${esc(st.target.name || "unlabeled " + st.target.role)}”` : ""}</span></div>
      <span>“${esc(st.thinkAloud)}”</span>
      <a href="/replay/${esc(S.id)}/step/${esc(st.id)}" data-replay="${esc(st.sessionId)}" data-at="${st.startedAt}" data-title="${esc(p?.name ?? "")} · step ${st.idx + 1}">${icon("film")} Watch it happen</a></div></div>`;
  }).join("");
  wireZoom(ev);
  wireReplays(S, el);
}

async function exportIssue(S, i, to) {
  try {
    const r = await api.exportIssue(i.id, to, S.id, false);
    if (r.sent) { toast(`Created in ${to}${r.url ? `: ${r.url}` : ""}`); if (r.url) window.open(r.url, "_blank"); return; }
    const d = drawer(`<h2>Export to ${esc(to)}</h2>`);
    const body = r.payload?.body ?? r.payload?.fields?.description ?? r.payload?.variables?.input?.description ?? JSON.stringify(r.payload, null, 2);
    d.body.innerHTML = `<div class="card card-body"><b>Not sent:</b> ${esc(r.reason)}. Add the credentials to <code>.env</code> to file issues directly; until then, copy the ready-made ticket below.</div>
      <pre class="yaml" style="max-height:none">${esc(body)}</pre><div><button class="btn" id="copy">${icon("check")}Copy ticket</button></div>`;
    d.body.querySelector("#copy").addEventListener("click", () => { navigator.clipboard.writeText(body); toast("Copied"); });
  } catch (e) {
    toast(e.message, "bad");
  }
}

// ---------------------------------------------------------------- sessions
function renderSessions(S) {
  const el = $("#tab");
  const rows = [...S.sessions.values()];
  el.innerHTML = `<div class="card"><div class="table-wrap"><table class="table">
    <thead><tr><th>Persona</th><th>Task</th><th>Run</th><th>Outcome</th><th class="num">Steps</th><th class="num">Human time</th><th class="num">Cost</th><th>Last page</th></tr></thead>
    <tbody>${rows.map((s) => {
      const p = S.personas.get(s.personaId);
      return `<tr class="click" data-sid="${esc(s.id)}"><td><div class="row" style="gap:8px;flex-wrap:nowrap">${avatar(p?.name, p?.id)}<div><b>${esc(p?.name)}</b><div class="small muted">${esc(personaTag(p ?? {}))}</div></div></div></td>
        <td>${esc(s.taskId)}</td><td class="muted">#${s.repetition + 1}</td>
        <td>${statusPill(s.outcome ?? s.status)}${s.outcomeDetail ? `<div class="small muted" style="max-width:340px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${esc(s.outcomeDetail)}">${esc(s.outcomeDetail)}</div>` : ""}</td>
        <td class="num">${s.stepCount || "—"}</td><td class="num">${secs(s.estHumanMs)}</td><td class="num">${s.cost ? money(s.cost, 3) : "—"}</td>
        <td><code class="muted">${esc(s.last?.pagePath ?? "")}</code></td></tr>`;
    }).join("")}</tbody></table></div></div>`;
  $$("tr[data-sid]", el).forEach((tr) => tr.addEventListener("click", () => openSession(S, tr.dataset.sid)));
}

async function openSession(S, sid) {
  const s = S.sessions.get(sid);
  const p = S.personas.get(s.personaId);
  const d = drawer(`${avatar(p?.name, p?.id, "lg")}<div><h2>${esc(p?.name)} · ${esc(s.taskId)} #${s.repetition + 1}</h2><div class="small muted">${esc(p?.archetype)} · ${statusPill(s.outcome ?? s.status)}</div></div>`);
  d.body.innerHTML = `<div class="skeleton" style="height:160px"></div>`;
  const [steps, signals] = await Promise.all([api.steps(S.id, sid), api.signals(S.id, sid)]);
  const sigBy = new Map();
  for (const x of signals) sigBy.set(x.stepId, [...(sigBy.get(x.stepId) ?? []), x.type]);
  d.body.innerHTML = `<div class="row"><button class="btn primary" data-replay="${esc(sid)}" data-title="${esc(p?.name)} · ${esc(s.taskId)} #${s.repetition + 1}">${icon("film")}Watch session replay</button><span class="muted small">${steps.length} steps · ${money(s.cost, 3)} · ~${secs(s.estHumanMs)} for a person</span></div>
    ${s.outcomeDetail ? `<div class="card card-body"><b>${esc(human(s.outcome ?? s.status))}:</b> ${esc(s.outcomeDetail)}</div>` : ""}
    ${steps.length ? "" : empty("clock", "No steps yet", "This session hasn't started.")}
    ${steps.map((st) => `<div class="step">
      <div>${st.artifacts.before_marked || st.artifacts.before ? `<img src="/blobs/${esc(st.artifacts.before_marked ?? st.artifacts.before)}" alt="Step ${st.idx + 1} screenshot" loading="lazy" data-zoom="${esc(st.artifacts.before ?? st.artifacts.before_marked)}" data-caption="Step ${st.idx + 1} · ${esc(st.pagePath)}"${st.target?.vbox ? ` data-vbox='${esc(JSON.stringify(st.target.vbox))}'` : ""}>` : `<div class="muted small">no screenshot (screen reader)</div>`}</div>
      <div class="stack" style="gap:6px">
        <div class="row" style="gap:6px"><b>Step ${st.idx + 1}</b><code class="muted">${esc(st.pagePath)}</code><span class="spacer"></span><span class="small muted">frustration ${st.frustration}/10</span></div>
        <div class="say">“${esc(st.thinkAloud)}”</div>
        <div class="act">${icon("arrowRight")} ${esc(st.action.type)}${st.target ? ` “${esc(st.target.name || "unlabeled " + st.target.role)}”` : ""}${st.action.text ? ` · typed “${esc(st.action.text)}”` : ""}${st.action.key ? ` · ${esc(st.action.key)}` : ""}</div>
        <div class="act">expected: ${esc(st.expectation.says)} ${st.observation.expectationMet === false ? '<span class="pill bad">didn\'t happen</span>' : st.observation.expectationMet ? '<span class="pill good">happened</span>' : ""}</div>
        ${(sigBy.get(st.id) ?? []).length ? `<div class="row" style="gap:4px">${sigBy.get(st.id).map((t) => `<span class="pill bad">${esc(human(t))}</span>`).join("")}</div>` : ""}
        <div class="small"><a href="/replay/${esc(S.id)}/step/${esc(st.id)}" data-replay="${esc(sid)}" data-at="${st.startedAt}" data-title="${esc(p?.name)} · step ${st.idx + 1}">${icon("film")} replay from here</a> · <span class="muted">${money(st.costUsd, 4)}</span></div>
      </div></div>`).join("")}`;
  wireZoom(d.body);
  wireReplays(S, d.body);
}

// Replay links open the in-app player at the step; the plain href still works in a new tab.
function wireReplays(S, root) {
  root.querySelectorAll("[data-replay]").forEach((a) => {
    if (a.dataset.wired) return;
    a.dataset.wired = "1";
    a.addEventListener("click", (e) => {
      if (e.metaKey || e.ctrlKey) return;
      e.preventDefault();
      openReplay(S.id, a.dataset.replay, a.dataset.title || "Session replay", a.dataset.at ? Number(a.dataset.at) : undefined);
    });
  });
}

// ---------------------------------------------------------------- report
async function renderReportTab(S) {
  const el = $("#tab");
  S.rd ??= await api.reportData(S.id).catch(() => null);
  const url = S.rd?.reportUrl;
  el.innerHTML = `<div class="toolbar">
      <button class="btn" id="rebuild">${icon("refresh")}${url ? "Rebuild" : "Build"} report</button>
      ${url ? `<a class="btn" href="${esc(url)}" target="_blank">${icon("external")}Open in new tab</a>
      <a class="btn" href="${esc(url.replace("index.html", "report.json"))}" download>${icon("download")}JSON</a>
      <button class="btn" id="pdf">${icon("download")}PDF</button>` : ""}
      <span class="spacer"></span><span class="small muted">Shareable HTML · same evidence as this workspace</span></div>
    ${url ? `<iframe class="report-frame" src="${esc(url)}" title="Study report"></iframe>` : empty("file", "No report yet", "Build one to get a shareable HTML report with a JSON export for CI.")}`;
  $("#rebuild").addEventListener("click", async (e) => {
    e.currentTarget.disabled = true;
    try { const r = await api.buildReport(S.id); S.rd = { ...(S.rd ?? {}), reportUrl: r.url }; renderReportTab(S); toast("Report built"); }
    catch (err) { toast(err.message, "bad"); e.currentTarget.disabled = false; }
  });
  $("#pdf")?.addEventListener("click", async (e) => {
    e.currentTarget.disabled = true;
    try { const r = await api.post(`/api/studies/${S.id}/report`, { pdf: true }); window.open(r.url.replace("index.html", "report.pdf"), "_blank"); }
    catch (err) { toast(err.message, "bad"); }
    e.currentTarget.disabled = false;
  });
}
