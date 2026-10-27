// Persona library: the curated cards and the mechanisms that enforce each trait.
import { api } from "../api.js";
import { setCrumbs } from "../app.js";
import { avatar, bar5, esc, icon, personaTraits } from "../ui.js";

export async function render(view) {
  setCrumbs([["Personas", "#/personas"]]);
  const personas = await api.personas();
  view.innerHTML = `
    <div class="page-head"><div><h1>Personas</h1><p>${personas.length} curated synthetic users. Traits are enforced in code — what they can see, what they can do, and how long they'll try — not just described in a prompt.</p></div>
      <a class="btn primary" href="#/new">${icon("plus")}Use in a study</a></div>
    <div class="persona-grid" style="grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:14px">
      ${personas.map((p) => `<article class="card" style="padding:16px;display:flex;flex-direction:column;gap:12px">
        <div class="row" style="gap:12px;flex-wrap:nowrap">${avatar(p.name, p.id, "lg")}<div style="min-width:0"><h3 style="font-size:15px">${esc(p.name)}</h3><div class="small muted">${esc(p.archetype)}</div></div></div>
        <div class="traits row" style="gap:4px">${personaTraits(p)}</div>
        <dl class="facts" style="grid-template-columns:120px 1fr;font-size:13px;margin:0">
          <dt>Digital literacy</dt><dd>${bar5(p.digital_literacy)}</dd>
          <dt>Domain knowledge</dt><dd>${bar5(p.domain_knowledge)}</dd>
          <dt>Reading</dt><dd>${esc(p.reading)}${p.reading === "skim" ? ' <span class="muted small">(sees ~12 words per block)</span>' : ""}</dd>
          <dt>Patience</dt><dd>${p.patience.max_steps} steps · ${p.patience.max_retries_per_obstacle} retries per obstacle</dd>
          ${p.vocabulary_gaps?.length ? `<dt>Doesn't know</dt><dd>${p.vocabulary_gaps.map((w) => `<span class="chip">${esc(w)}</span>`).join(" ")}</dd>` : ""}
        </dl>
        ${p.quirks?.length ? `<ul style="margin:0;padding-left:18px;color:var(--text-2);font-size:13px">${p.quirks.map((q) => `<li>${esc(q)}</li>`).join("")}</ul>` : ""}
      </article>`).join("")}
    </div>`;
}
