// New study wizard: Site → Tasks → Personas → Budget & launch, with a live summary and cost estimate.
import { api } from "../api.js";
import { me, refreshCredits, refreshMe, setCrumbs } from "../app.js";
import { $, $$, avatar, bar5, esc, icon, money, personaTag, personaTraits, toast } from "../ui.js";

const STEPS = ["Site", "Tasks", "Personas", "Budget & launch"];

// Draft survives navigation within the session.
const draft = (window.__swarmDraft ??= {
  name: "", target_url: "", allowed_domains: [], reset_url: "", permission: false,
  tasks: [{ id: "task-1", goal: "", start_url: "", rule: "network", value: "POST /api/orders 201" }],
  personas: null,
  budget: { repetitions: 2, concurrency: 6, max_steps: 25, cost_cap_usd: 1 },
});

export async function render(view) {
  setCrumbs([["Studies", "#/"], ["New study", "#/new"]]);
  const [personas, credits, cfg] = await Promise.all([api.personas(), api.credits().catch(() => ({})), api.config()]);
  // Hosted plans: a non-admin pays with the free run (small, capped) or their own OpenRouter key.
  const plan = me && me.mode === "google" && me.user.role !== "admin"
    ? { free: me.freeRunsLeft > 0, own: me.hasKey, last4: me.keyLast4, L: cfg.limits }
    : null;
  if (plan) draft.pay = draft.pay && ((draft.pay === "free" && plan.free) || (draft.pay === "own" && plan.own)) ? draft.pay : plan.free ? "free" : plan.own ? "own" : null;
  const demoUrl = `http://localhost:${cfg.demoShopPort ?? 4400}/`;
  draft.personas ??= personas.map((p) => p.id);
  let step = 0;
  let discovered = [];
  let estimate = null;

  view.innerHTML = `
    <div class="page-head"><div><h1>New study</h1><p>Describe what real people try to do on your site; the swarm does it in parallel and reports where they struggle.</p></div>
      <button class="btn ghost" id="demo">${icon("sparkle")}Fill with demo shop</button></div>
    <div class="wizard">
      <div>
        <div class="steps-nav" id="steps-nav"></div>
        <div class="card"><div class="card-body" id="step-body"></div>
          <div class="card-head" style="border-top:1px solid var(--border);border-bottom:0">
            <button class="btn" id="back">${icon("arrowLeft")}Back</button>
            <span class="spacer"></span>
            <span class="small" id="step-error" style="color:var(--bad)"></span>
            <button class="btn primary" id="next">Continue${icon("arrowRight")}</button>
          </div>
        </div>
      </div>
      <aside class="card summary"><div class="card-head"><h2>Summary</h2></div><div class="card-body" id="summary"></div></aside>
    </div>`;

  const spec = () => ({
    name: draft.name || "Untitled study",
    target_url: draft.target_url,
    allowed_domains: draft.allowed_domains,
    permission_confirmed: draft.permission,
    ...(draft.reset_url ? { reset_url: draft.reset_url } : {}),
    tasks: draft.tasks.filter((t) => t.goal.trim()).map((t) => ({ id: slug(t.id) || "task", goal: t.goal.trim(), ...(t.start_url ? { start_url: t.start_url } : {}), success: successRule(t) })),
    personas: { include: draft.personas },
    budget: { ...draft.budget },
  });

  const validate = (i) => {
    if (i === 0) {
      if (!/^https?:\/\//.test(draft.target_url)) return "Enter the full URL of the site, starting with http:// or https://";
      if (!draft.allowed_domains.length) return "Add at least one allowed domain";
      if (!draft.permission) return "Confirm you own the site or have written permission to test it";
    }
    if (i === 1) {
      const ts = draft.tasks.filter((t) => t.goal.trim());
      if (!ts.length) return "Describe at least one task";
      if (ts.some((t) => !t.value.trim())) return "Every task needs a success rule the code can check";
    }
    if (i === 2 && !draft.personas.length) return "Pick at least one persona";
    if (i === 3 && plan) {
      if (!draft.pay) return "Your free run is used. Add your OpenRouter key in Settings to launch.";
      if (draft.pay === "free" && sessions() > plan.L.freeMaxSessions) return `The free run allows up to ${plan.L.freeMaxSessions} sessions; this has ${sessions()}. Use fewer personas, tasks or repetitions.`;
      if (draft.pay === "own" && sessions() > plan.L.userMaxSessions) return `Runs are limited to ${plan.L.userMaxSessions} sessions; this has ${sessions()}.`;
    }
    return "";
  };

  const sessions = () => draft.personas.length * Math.max(1, draft.tasks.filter((t) => t.goal.trim()).length) * draft.budget.repetitions;

  let estTimer = null;
  const refreshEstimate = () => {
    clearTimeout(estTimer);
    estTimer = setTimeout(async () => {
      try { estimate = await api.estimate({ ...spec(), permission_confirmed: true, target_url: draft.target_url || "http://localhost/", allowed_domains: draft.allowed_domains.length ? draft.allowed_domains : ["localhost"], tasks: spec().tasks.length ? spec().tasks : [{ id: "t", goal: "g", success: { url_pattern: "x" } }] }); }
      catch { estimate = null; }
      drawSummary();
    }, 350);
  };

  const drawSummary = () => {
    const left = credits.remainingUsd;
    $("#summary").innerHTML = `
      <div class="line"><span class="muted">Site</span><b style="max-width:170px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(draft.target_url || "—")}</b></div>
      <div class="line"><span class="muted">Tasks</span><b>${draft.tasks.filter((t) => t.goal.trim()).length}</b></div>
      <div class="line"><span class="muted">Personas</span><b>${draft.personas.length}</b></div>
      <div class="line"><span class="muted">Repetitions</span><b>${draft.budget.repetitions}</b></div>
      <div class="line"><span class="muted">Sessions</span><b class="tnum">${sessions()}</b></div>
      <div style="margin-top:14px"><div class="muted small">Estimated cost</div><div class="big tnum">${estimate ? money(estimate.totalUsd) : "—"}</div>
        <div class="small muted">${estimate ? `worst case ${money(estimate.worstCaseUsd)} · capped at ${money(draft.budget.cost_cap_usd)}` : ""}</div></div>
      ${left != null ? `<div style="margin-top:12px" class="small muted">You have <b class="tnum" style="color:var(--text)">${money(left)}</b> of credit; studies never spend below ${money(credits.reserveUsd)}.</div>` : ""}
      ${estimate && left != null && estimate.worstCaseUsd > left - (credits.reserveUsd ?? 0) ? `<div class="pill warn" style="margin-top:10px">${icon("alert")}Worst case exceeds your credit; the cap will stop it early</div>` : ""}`;
  };

  const drawNav = () => {
    $("#steps-nav").innerHTML = STEPS.map((s, i) => `<button class="${i === step ? "on" : i < step ? "done" : ""}" data-i="${i}"><span class="n">${i < step ? icon("check") : i + 1}</span>${s}</button>`).join("");
    $$("#steps-nav button").forEach((b) => b.addEventListener("click", () => { const i = Number(b.dataset.i); if (i <= step || !validate(step)) go(i); }));
    $("#back").style.visibility = step ? "visible" : "hidden";
    $("#next").innerHTML = step === STEPS.length - 1 ? `${icon("play")}Launch swarm` : `Continue${icon("arrowRight")}`;
  };

  const go = (i) => { step = i; $("#step-error").textContent = ""; drawNav(); drawStep(); };

  const drawStep = () => {
    const body = $("#step-body");
    if (step === 0) {
      body.innerHTML = `
        <div class="field"><label for="f-name">Study name</label><input class="input" id="f-name" value="${esc(draft.name)}" placeholder="Checkout on staging, October release"></div>
        <div class="field"><label for="f-url">Site URL</label>
          <div class="row" style="flex-wrap:nowrap"><input class="input" id="f-url" value="${esc(draft.target_url)}" placeholder="https://staging.example.com/"><button class="btn" id="discover">${icon("search")}Find domains</button></div>
          <span class="hint">Use staging or a preview deploy where possible. Test only sites you own or may test.</span></div>
        <div class="field"><label>Allowed domains</label>
          <span class="hint">The browsers can only reach these hosts. Keep the app, its API, CDN and login; leave out analytics and ads.</span>
          <div class="domain-list" id="domains"></div>
          <div class="row" style="flex-wrap:nowrap"><input class="input" id="f-dom" placeholder="add a domain, e.g. api.example.com"><button class="btn" id="add-dom">${icon("plus")}Add</button></div></div>
        <div class="field"><label for="f-reset">Reset URL <span class="muted">(optional)</span></label><input class="input" id="f-reset" value="${esc(draft.reset_url)}" placeholder="POSTed before each session to reset test data"></div>
        <label class="check-line"><input type="checkbox" id="f-perm" ${draft.permission ? "checked" : ""}><span><b>I own this site or have written permission to test it.</b><br><span class="muted small">The swarm identifies itself in its user agent, respects rate limits and cannot leave the allowed domains.</span></span></label>`;
      const drawDomains = () => {
        const all = [...new Set([...draft.allowed_domains, ...discovered.map((d) => d.host)])];
        $("#domains").innerHTML = all.length
          ? all.map((h) => { const d = discovered.find((x) => x.host === h); return `<label><input type="checkbox" data-host="${esc(h)}" ${draft.allowed_domains.includes(h) ? "checked" : ""}>${esc(h)}${d ? `<span class="muted" style="margin-left:auto">${d.requests} requests</span>` : ""}</label>`; }).join("")
          : `<span class="muted small" style="padding:6px">No domains yet. Enter the site URL and press Find domains.</span>`;
        $$("#domains input").forEach((c) => c.addEventListener("change", () => {
          draft.allowed_domains = c.checked ? [...new Set([...draft.allowed_domains, c.dataset.host])] : draft.allowed_domains.filter((x) => x !== c.dataset.host);
          drawSummary();
        }));
      };
      drawDomains();
      $("#f-name").addEventListener("input", (e) => { draft.name = e.target.value; });
      $("#f-url").addEventListener("input", (e) => {
        draft.target_url = e.target.value.trim();
        try { const h = new URL(draft.target_url).hostname; if (h && !draft.allowed_domains.length) { draft.allowed_domains = [h]; drawDomains(); } } catch {}
        drawSummary();
      });
      $("#f-reset").addEventListener("input", (e) => { draft.reset_url = e.target.value.trim(); });
      $("#f-perm").addEventListener("change", (e) => { draft.permission = e.target.checked; });
      $("#add-dom").addEventListener("click", () => { const v = $("#f-dom").value.trim().replace(/^https?:\/\//, "").split("/")[0]; if (v) { draft.allowed_domains = [...new Set([...draft.allowed_domains, v])]; $("#f-dom").value = ""; drawDomains(); } });
      $("#discover").addEventListener("click", async (e) => {
        const b = e.currentTarget;
        b.disabled = true; b.innerHTML = `${icon("refresh")}Loading site…`;
        try {
          discovered = await api.domains(draft.target_url);
          const home = new URL(draft.target_url).hostname;
          draft.allowed_domains = [...new Set([...draft.allowed_domains, home])];
          toast(`Found ${discovered.length} host${discovered.length === 1 ? "" : "s"}`);
        } catch (err) { toast(err.message, "bad"); }
        b.disabled = false; b.innerHTML = `${icon("search")}Find domains`;
        drawDomains();
      });
    }

    if (step === 1) {
      body.innerHTML = `<p class="muted" style="margin-top:0">Write each goal the way a customer would say it, not in the site's words. The success rule is checked in code, never taken on the agent's word.</p>
        <div id="tasks"></div><button class="btn" id="add-task" ${draft.tasks.length >= 5 ? "disabled" : ""}>${icon("plus")}Add task</button>`;
      const drawTasks = () => {
        $("#tasks").innerHTML = draft.tasks.map((t, i) => `
          <div class="task-card" data-i="${i}">
            <div class="row" style="flex-wrap:nowrap"><input class="input" data-k="id" value="${esc(t.id)}" style="max-width:200px" aria-label="Task id"><span class="spacer"></span>${draft.tasks.length > 1 ? `<button class="icon-btn" data-del aria-label="Remove task">${icon("trash")}</button>` : ""}</div>
            <textarea class="input" rows="2" data-k="goal" placeholder="Buy a birthday present under $40 and have it delivered">${esc(t.goal)}</textarea>
            <div class="row" style="flex-wrap:nowrap">
              <select class="input" data-k="rule" style="max-width:190px" aria-label="Success rule type">
                ${[["network", "API call returns"], ["url", "URL contains / matches"], ["text", "Text appears on page"], ["judge", "AI judge (fuzzy)"]].map(([v, l]) => `<option value="${v}" ${t.rule === v ? "selected" : ""}>${l}</option>`).join("")}
              </select>
              <input class="input" data-k="value" value="${esc(t.value)}" placeholder="${placeholder(t.rule)}" aria-label="Success rule">
            </div>
            <input class="input" data-k="start_url" value="${esc(t.start_url)}" placeholder="Start page (optional, defaults to the site URL)">
          </div>`).join("");
        $$("#tasks .task-card").forEach((card) => {
          const t = draft.tasks[Number(card.dataset.i)];
          $$("[data-k]", card).forEach((inp) => inp.addEventListener("input", () => { t[inp.dataset.k] = inp.value; if (inp.dataset.k === "rule") { $("[data-k=value]", card).placeholder = placeholder(inp.value); } refreshEstimate(); drawSummary(); }));
          $("[data-del]", card)?.addEventListener("click", () => { draft.tasks.splice(Number(card.dataset.i), 1); drawTasks(); refreshEstimate(); });
        });
      };
      drawTasks();
      $("#add-task").addEventListener("click", () => { if (draft.tasks.length < 5) { draft.tasks.push({ id: `task-${draft.tasks.length + 1}`, goal: "", start_url: "", rule: "url", value: "" }); drawTasks(); } });
    }

    if (step === 2) {
      const groups = [["all", "All"], ["mobile", "Mobile"], ["a11y", "Assistive tech"], ["novice", "Low literacy"], ["none", "None"]];
      body.innerHTML = `<div class="row" style="margin-bottom:12px"><span class="muted">Quick select</span><div class="seg" id="qs">${groups.map(([k, l]) => `<button data-k="${k}">${l}</button>`).join("")}</div><span class="spacer"></span><span class="small muted" id="pcount"></span></div>
        <div class="persona-grid" id="pgrid"></div>`;
      const drawGrid = () => {
        $("#pgrid").innerHTML = personas.map((p) => `<button class="pcard ${draft.personas.includes(p.id) ? "on" : ""}" data-id="${esc(p.id)}" aria-pressed="${draft.personas.includes(p.id)}">
          <span class="check">${icon("check")}</span>
          <div class="row" style="gap:10px;flex-wrap:nowrap">${avatar(p.name, p.id, "lg")}<div style="min-width:0"><b>${esc(p.name)}</b><div class="small muted">${esc(p.archetype)}</div></div></div>
          <div class="traits">${personaTraits(p)}</div>
          <div class="small muted">Digital literacy ${bar5(p.digital_literacy)} · reads: ${esc(p.reading)}</div></button>`).join("");
        $("#pcount").textContent = `${draft.personas.length} of ${personas.length} selected`;
        $$("#pgrid .pcard").forEach((c) => c.addEventListener("click", () => {
          const id = c.dataset.id;
          draft.personas = draft.personas.includes(id) ? draft.personas.filter((x) => x !== id) : [...draft.personas, id];
          drawGrid(); drawSummary(); refreshEstimate();
        }));
      };
      drawGrid();
      $$("#qs button").forEach((b) => b.addEventListener("click", () => {
        const k = b.dataset.k;
        const pick = { all: () => true, none: () => false, mobile: (p) => p.mobile, a11y: (p) => p.accessibility.screen_reader || p.accessibility.keyboard_only || p.accessibility.zoom > 100 || p.accessibility.color_vision !== "normal", novice: (p) => p.digital_literacy <= 2 }[k];
        draft.personas = personas.filter(pick).map((p) => p.id);
        drawGrid(); drawSummary(); refreshEstimate();
      }));
    }

    if (step === 3) {
      const b = draft.budget;
      const free = plan && draft.pay === "free";
      if (free) { b.cost_cap_usd = Math.min(b.cost_cap_usd, plan.L.freeCostCapUsd); b.max_steps = Math.min(b.max_steps, plan.L.freeMaxSteps); b.concurrency = Math.min(b.concurrency, 2); }
      const payHtml = plan ? `<div class="field"><label>Pay with</label>
          ${!plan.free && !plan.own ? `<div class="banner">${icon("alert")}<span>You've used your free run. <a href="#/settings">Add your OpenRouter API key</a> to keep running studies — it's validated, encrypted, and used only for your runs.</span></div>` : ""}
          <div class="grid cols-2">
            <button type="button" class="pay-option ${draft.pay === "free" ? "on" : ""}" data-pay="free" aria-disabled="${!plan.free}"><span class="radio"></span><span><b>Free run</b> <span class="pill ${plan.free ? "good" : ""}">${plan.free ? "1 left" : "used"}</span><br><span class="small muted">On us · up to ${plan.L.freeMaxSessions} sessions, ${plan.L.freeMaxSteps} steps each, $${plan.L.freeCostCapUsd.toFixed(2)} cap</span></span></button>
            <button type="button" class="pay-option ${draft.pay === "own" ? "on" : ""}" data-pay="own" aria-disabled="${!plan.own}"><span class="radio"></span><span><b>My OpenRouter key</b> ${plan.own ? `<span class="pill">···${esc(plan.last4)}</span>` : ""}<br><span class="small muted">${plan.own ? `Billed to your key · up to ${plan.L.userMaxSessions} sessions` : `<a href="#/settings">Add a key in Settings</a>`}</span></span></button>
          </div></div>` : "";
      body.innerHTML = `${payHtml}
        <div class="grid cols-2">
          <div class="field"><label for="b-rep">Repetitions per persona × task</label><input class="input" type="number" id="b-rep" min="1" max="10" value="${b.repetitions}"><span class="hint">3 separates noise from findings: one failure in three is noise, three in three is an issue.</span></div>
          <div class="field"><label for="b-conc">Parallel browsers</label><input class="input" type="number" id="b-conc" min="1" max="20" value="${b.concurrency}"><span class="hint">Politeness: 5–10 is gentle on most sites.</span></div>
          <div class="field"><label for="b-steps">Max steps per session</label><input class="input" type="number" id="b-steps" min="5" max="100" value="${b.max_steps}"><span class="hint">Personas also give up on their own when patience runs out.</span></div>
          <div class="field"><label for="b-cap">Cost cap (USD)</label><input class="input" type="number" id="b-cap" min="0.05" step="0.05" value="${b.cost_cap_usd}"><span class="hint">Hard stop; also limited by your remaining credit.</span></div>
        </div>
        <details><summary class="small" style="cursor:pointer">Show study file (YAML)</summary><pre class="yaml" id="yaml"></pre></details>`;
      const upd = () => {
        b.repetitions = clampNum($("#b-rep").value, 1, 10); b.concurrency = clampNum($("#b-conc").value, 1, 20);
        b.max_steps = clampNum($("#b-steps").value, 5, 100); b.cost_cap_usd = Math.max(0.05, Number($("#b-cap").value) || 1);
        $("#yaml").textContent = toYaml(spec());
        drawSummary(); refreshEstimate();
      };
      $$("#step-body input").forEach((i) => i.addEventListener("input", upd));
      $$("[data-pay]").forEach((btn) => btn.addEventListener("click", () => { if (btn.getAttribute("aria-disabled") === "true") return; draft.pay = btn.dataset.pay; drawStep(); drawSummary(); refreshEstimate(); }));
      if (free) { $("#b-cap").disabled = true; $("#b-cap").max = plan.L.freeCostCapUsd; $("#b-steps").max = plan.L.freeMaxSteps; }
      $("#yaml").textContent = toYaml(spec());
      drawSummary();
    }
  };

  $("#back").addEventListener("click", () => go(Math.max(0, step - 1)));
  $("#next").addEventListener("click", async () => {
    const err = validate(step);
    if (err) { $("#step-error").textContent = err; return; }
    if (step < STEPS.length - 1) return go(step + 1);
    const b = $("#next");
    b.disabled = true;
    try {
      const { id } = await api.launch({ ...spec(), ...(plan ? { useOwnKey: draft.pay === "own" } : {}) });
      if (plan) { await refreshMe(); refreshCredits(); }
      toast("Swarm launched");
      window.__swarmDraft = null;
      location.hash = `#/study/${id}/live`;
    } catch (e) {
      $("#step-error").innerHTML = /Settings/.test(e.message) ? `${esc(e.message)} <a href="#/settings">Open Settings</a>` : esc(e.message);
      b.disabled = false;
    }
  });
  $("#demo").addEventListener("click", () => {
    Object.assign(draft, {
      name: "Kindling & Co. — gift purchase", target_url: demoUrl, allowed_domains: ["localhost"], reset_url: `${demoUrl}__reset`, permission: true,
      tasks: [
        { id: "buy-gift", goal: "Buy a birthday present for a friend that costs less than $40, and have it delivered to your home.", start_url: "", rule: "network", value: "POST /api/orders 201" },
        { id: "search-teen-gift", goal: "Use the shop's search to find a gift for a teenager, and put it in your bag.", start_url: "", rule: "network", value: "POST /api/bag 200" },
      ],
    });
    if (plan && draft.pay === "free") {
      // Fit the free run: one task, six personas, one repetition.
      draft.tasks = draft.tasks.slice(0, 1);
      draft.personas = personas.slice(0, plan.L.freeMaxSessions).map((p) => p.id);
      draft.budget.repetitions = 1;
    }
    go(step);
    refreshEstimate();
    toast(cfg.demoShop ? "Filled with the built-in demo shop" : "Filled with the demo shop (npm run shop)");
  });

  drawNav(); drawStep(); drawSummary(); refreshEstimate();
}

function successRule(t) {
  const v = t.value.trim();
  if (t.rule === "network") {
    const m = v.match(/^(\w+)\s+(\S+)(?:\s+(\d{3}))?$/);
    return m ? { network: { method: m[1].toUpperCase(), url_pattern: m[2], ...(m[3] ? { status: Number(m[3]) } : {}) } } : { network: { method: "POST", url_pattern: v } };
  }
  if (t.rule === "url") return { url_pattern: v };
  if (t.rule === "text") return { text_present: v };
  return { llm_judge: v };
}
const placeholder = (rule) => ({ network: "POST /api/orders 201", url: "/order/confirmed", text: "Order confirmed", judge: "The order confirmation is showing" })[rule] ?? "";
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const clampNum = (v, lo, hi) => Math.min(hi, Math.max(lo, Math.round(Number(v) || lo)));

function toYaml(v, indent = "") {
  if (Array.isArray(v)) return v.length ? v.map((x) => `\n${indent}- ${toYaml(x, indent + "  ").trimStart()}`).join("") : " []";
  if (v && typeof v === "object") return Object.entries(v).map(([k, x]) => `\n${indent}${k}:${typeof x === "object" && x !== null ? toYaml(x, indent + "  ") : ` ${JSON.stringify(x)}`}`).join("");
  return JSON.stringify(v);
}
