// Compare runs: pick a baseline and a newer study; issues are labelled new, fixed, regressed or unchanged.
import { api } from "../api.js";
import { setCrumbs } from "../app.js";
import { ago, empty, esc, icon, sevBadge } from "../ui.js";

export async function render(view, [baseId, headId]) {
  setCrumbs([["Compare runs", "#/compare"]]);
  const studies = (await api.studies()).filter((s) => !s.running);
  if (studies.length < 2) {
    view.innerHTML = `<div class="page-head"><div><h1>Compare runs</h1><p>See what a fix changed: issues new, fixed, regressed or unchanged between two studies.</p></div></div>
      <div class="card">${empty("diff", "Two finished studies needed", "Run a study, ship a fix, run it again — then compare the two here.", `<a class="btn primary" href="#/new">${icon("plus")}New study</a>`)}</div>`;
    return;
  }
  // Default: the latest run and the previous run of the same study (same name), else the two latest.
  if (!baseId || !headId) {
    const pair = studies.map((h, i) => [h, studies.slice(i + 1).find((b) => b.name === h.name)]).find(([, b]) => b);
    headId ??= (pair?.[0] ?? studies[0]).id;
    baseId ??= (pair?.[1] ?? studies[1]).id;
  }
  const opt = (sel) => studies.map((s) => `<option value="${esc(s.id)}" ${s.id === sel ? "selected" : ""}>${esc(s.name)} — ${ago(s.createdAt)}</option>`).join("");
  view.innerHTML = `
    <div class="page-head"><div><h1>Compare runs</h1><p>Pick the earlier run as the baseline and a later run on the same tasks. Issues are matched by page, element and wording.</p></div></div>
    <div class="card card-body" style="margin-bottom:16px">
      <div class="grid cols-2" style="align-items:end">
        <div class="field" style="margin:0"><label for="base">Baseline (before)</label><select class="input" id="base">${opt(baseId)}</select></div>
        <div class="field" style="margin:0"><label for="head">Compared run (after)</label><select class="input" id="head">${opt(headId)}</select></div>
      </div>
    </div>
    <div id="diff"></div>`;
  const go = () => { location.hash = `#/compare/${document.getElementById("base").value}/${document.getElementById("head").value}`; };
  document.getElementById("base").addEventListener("change", go);
  document.getElementById("head").addEventListener("change", go);

  const out = document.getElementById("diff");
  if (baseId === headId) { out.innerHTML = `<div class="card card-body muted">Pick two different studies.</div>`; return; }
  const d = await api.get(`/api/studies/${headId}/diff/${baseId}`);
  const c = d.counts;
  out.innerHTML = `
    <div class="grid cols-4" style="margin-bottom:16px">
      ${[["fixed", "Fixed", "check"], ["new", "New", "alert"], ["regressed", "Regressed", "activity"], ["unchanged", "Unchanged", "diff"]].map(([k, l, ic]) => `<div class="card kpi"><div class="label">${icon(ic)}${l}</div><div class="value tnum">${c[k]}</div><div class="sub"><span class="pill ${k}">${l.toLowerCase()}</span></div></div>`).join("")}
    </div>
    <div class="card"><div class="table-wrap"><table class="table">
      <thead><tr><th>Change</th><th>Issue</th><th class="num">Before</th><th class="num">After</th></tr></thead>
      <tbody>${d.rows.length ? d.rows.map((r) => `<tr class="diff-row ${r.headIssueId || r.baseIssueId ? "click" : ""}" data-href="${r.headIssueId ? `#/study/${esc(headId)}/issues/${esc(r.headIssueId)}` : `#/study/${esc(baseId)}/issues/${esc(r.baseIssueId)}`}">
        <td><span class="pill ${r.status}">${r.status}</span></td><td><b style="font-weight:550">${esc(r.title)}</b></td>
        <td class="num">${r.baseSeverity != null ? sevBadge(r.baseSeverity) : '<span class="muted">—</span>'}</td>
        <td class="num">${r.status === "fixed" ? '<span class="muted">—</span>' : sevBadge(r.severity)}</td></tr>`).join("") : `<tr><td colspan="4" class="muted">Neither study has issues.</td></tr>`}</tbody></table></div></div>`;
  out.querySelectorAll("tr[data-href]").forEach((tr) => tr.addEventListener("click", () => (location.hash = tr.dataset.href)));
}
