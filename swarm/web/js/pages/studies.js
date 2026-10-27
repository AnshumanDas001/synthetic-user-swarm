// Studies overview: totals across studies and one row per study.
import { api } from "../api.js";
import { setCrumbs } from "../app.js";
import { ago, empty, esc, hostPath, icon, money, pct, statusPill } from "../ui.js";

export async function render(view) {
  setCrumbs([["Studies", "#/"]]);
  document.getElementById("topbar-right").innerHTML = `<a class="btn primary" href="#/new">${icon("plus")}New study</a>`;
  view.innerHTML = `<div class="skeleton" style="height:120px;margin-bottom:16px"></div><div class="skeleton" style="height:320px"></div>`;

  const filter = { status: "all", q: "" };
  let qt = null;
  const shown = (list) => list.filter((s) => (filter.status === "all" || (filter.status === "running" ? s.running : s.status === filter.status)) && (!filter.q || `${s.name} ${s.targetUrl}`.toLowerCase().includes(filter.q.toLowerCase())));
  const load = async () => {
    const list = await api.studies();
    const totals = list.reduce((a, s) => ({
      sessions: a.sessions + s.finished, issues: a.issues + s.issues, cost: a.cost + s.costUsd,
      critical: a.critical + s.severity.critical + s.severity.major, running: a.running + (s.running ? 1 : 0),
    }), { sessions: 0, issues: 0, cost: 0, critical: 0, running: 0 });

    view.innerHTML = `
      <div class="page-head">
        <div><h1>Studies</h1><p>Each study sends a swarm of personas at a site and turns where they struggle into evidence-backed issues.</p></div>
      </div>
      <div class="grid cols-4" style="margin-bottom:20px">
        ${kpi("layers", "Studies", list.length, totals.running ? `${totals.running} running now` : "none running")}
        ${kpi("users", "Sessions run", totals.sessions, "persona × task × repetition")}
        ${kpi("alert", "Issues found", totals.issues, `${totals.critical} major or worse`)}
        ${kpi("coins", "Total spend", money(totals.cost), "across all studies")}
      </div>
      <div class="card">
        ${list.length ? `<div class="filters" style="justify-content:space-between"><div class="seg" id="sf">${["all", "running", "complete", "stopped"].map((k) => `<button data-k="${k}" class="${k === filter.status ? "on" : ""}">${k[0].toUpperCase() + k.slice(1)}</button>`).join("")}</div>
          <input class="input" id="sq" placeholder="Filter by name or site" style="max-width:280px" value="${esc(filter.q)}" aria-label="Filter studies"></div>
          <div class="table-wrap"><table class="table">
          <thead><tr><th>Study</th><th>Status</th><th style="width:22%">Progress</th><th class="num">Task success</th><th>Issues</th><th class="num">Spend</th><th>Created</th></tr></thead>
          <tbody>${shown(list).map(row).join("") || `<tr><td colspan="7" class="muted">No studies match.</td></tr>`}</tbody></table></div>`
        : empty("layers", "No studies yet", "Point a swarm of synthetic users at a site you own and see where they struggle.", `<a class="btn primary" href="#/new">${icon("plus")}Create your first study</a>`)}
      </div>`;
    view.querySelectorAll("tr[data-id]").forEach((tr) => tr.addEventListener("click", () => (location.hash = `#/study/${tr.dataset.id}`)));
    view.querySelectorAll("#sf button").forEach((b) => b.addEventListener("click", () => { filter.status = b.dataset.k; load(); }));
    view.querySelector("#sq")?.addEventListener("input", (e) => { filter.q = e.target.value; clearTimeout(qt); qt = setTimeout(() => { load().then(() => { const i = view.querySelector("#sq"); i?.focus(); i?.setSelectionRange(i.value.length, i.value.length); }); }, 200); });
    return list.some((s) => s.running);
  };

  let running = await load();
  // Keep running studies' progress fresh.
  const timer = setInterval(async () => { if (running) running = await load().catch(() => running); }, 5000);
  return () => clearInterval(timer);
}

function kpi(ic, label, value, sub) {
  return `<div class="card kpi"><div class="label">${icon(ic)}${esc(label)}</div><div class="value tnum">${esc(value)}</div><div class="sub">${esc(sub)}</div></div>`;
}

function row(s) {
  const done = s.sessions ? s.finished / s.sessions : 0;
  const sev = s.severity;
  return `<tr class="click" data-id="${esc(s.id)}">
    <td><div class="study-name">${esc(s.name)}</div><div class="study-url">${esc(hostPath(s.targetUrl))} · ${s.personas} personas × ${s.tasks.length} task${s.tasks.length > 1 ? "s" : ""} × ${s.repetitions}</div></td>
    <td>${statusPill(s.running ? "running" : s.status)}</td>
    <td><div class="row" style="gap:8px;flex-wrap:nowrap"><div class="progress" style="flex:1"><span class="run" style="width:${done * 100}%"></span></div><span class="small muted tnum">${s.finished}/${s.sessions}</span></div></td>
    <td class="num">${pct(s.analysable ? s.succeeded / s.analysable : null)}</td>
    <td><div class="row" style="gap:4px">${s.issues ? `<b class="tnum">${s.issues}</b>` : '<span class="muted">—</span>'}
      ${sev.critical ? `<span class="sev critical">${sev.critical}</span>` : ""}${sev.major ? `<span class="sev major">${sev.major}</span>` : ""}${sev.minor ? `<span class="sev minor">${sev.minor}</span>` : ""}</div></td>
    <td class="num">${money(s.costUsd)}</td>
    <td class="muted">${ago(s.createdAt)}</td>
  </tr>`;
}
