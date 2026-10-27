// Settings: what the swarm is configured to use (read from the environment; change it in .env and restart).
import { api } from "../api.js";
import { me, refreshCredits, refreshMe, setCrumbs } from "../app.js";
import { esc, icon, money, toast } from "../ui.js";

export async function render(view) {
  setCrumbs([["Settings", "#/settings"]]);
  const [cfg, credits] = await Promise.all([api.config(), api.credits().catch(() => ({}))]);
  const row = (name, desc, value) => `<div class="setting"><div><div class="name">${name}</div><div class="desc">${desc}</div></div><div>${value}</div></div>`;
  const code = (v) => /^[A-Z_]+$/.test(v) ? `<span class="chip mono" style="margin-left:8px;font-size:11px" title="environment variable">${esc(v)}</span>` : `<code>${esc(v)}</code>`;
  const on = (b, yes = "Connected", no = "Not configured") => `<span><span class="status-dot ${b ? "on" : ""}"></span>${b ? yes : no}</span>`;
  const hosted = cfg.authMode === "google";
  const account = hosted ? `
      <div class="card"><div class="card-head"><h2>${icon("users")} Your account</h2></div>
        ${row("Signed in as", "With Google. Your studies, screenshots and replays are visible only to you.", `<b>${esc(me?.user.name ?? "")}</b> <span class="muted">${esc(me?.user.email ?? "")}</span>`)}
        ${row("Plan", "Every account gets a free run on us; after that, runs use your own OpenRouter key.", me?.user.role === "admin" ? '<span class="pill accent">Admin · platform key, no limits</span>' : me?.freeRunsLeft > 0 ? `<span class="pill good">${me.freeRunsLeft} free run left</span> <span class="muted small">up to ${cfg.limits.freeMaxSessions} sessions · ${cfg.limits.freeMaxSteps} steps each</span>` : '<span class="pill warn">Free run used</span>')}
      </div>
      <div class="card" id="key-card"><div class="card-head"><h2>${icon("shield")} Your OpenRouter API key</h2>${me?.hasKey ? `<span class="pill good"><span class="dot"></span>Saved ···${esc(me.keyLast4)}</span>` : ""}</div>
        <div class="card-body stack" style="gap:12px">
          <p class="muted" style="margin:0">Runs on your key are billed by OpenRouter to you, with up to ${cfg.limits.userMaxSessions} sessions each. The key is checked with OpenRouter, stored encrypted, and never shown again. Get one at <a href="https://openrouter.ai/keys" target="_blank" rel="noopener">openrouter.ai/keys</a> — a few dollars runs many studies (about $0.01 per session).</p>
          <div class="row" style="flex-wrap:nowrap"><input class="input" id="key" type="password" autocomplete="off" placeholder="${me?.hasKey ? "Replace with a new key (sk-or-…)" : "sk-or-v1-…"}" aria-label="OpenRouter API key"><button class="btn primary" id="save-key">${me?.hasKey ? "Replace" : "Save key"}</button>${me?.hasKey ? `<button class="btn danger" id="remove-key">Remove</button>` : ""}</div>
          <div class="small" id="key-msg" role="status"></div>
        </div>
      </div>` : "";
  view.innerHTML = `
    <div class="page-head"><div><h1>Settings</h1><p>${hosted && !cfg.admin ? "Your account, plan and API key." : "Read from the environment (<code>.env</code>). Change a value there and restart the server."}</p></div></div>
    <div class="stack">${account}
      ${hosted && !cfg.admin ? "" : `
      <div class="card"><div class="card-head"><h2>${icon("coins")} Model credit</h2><button class="btn sm" id="refresh">${icon("refresh")}Refresh</button></div>
        ${row("Mode", "Live calls models through OpenRouter; offline uses a deterministic policy for tests.", cfg.mode === "live" ? '<span class="pill good"><span class="dot"></span>Live</span>' : '<span class="pill"><span class="dot"></span>Offline</span>')}
        ${row("Credit left", "On this OpenRouter key.", credits.remainingUsd != null ? `<b class="tnum">${money(credits.remainingUsd)}</b> <span class="muted">of ${money(credits.limitUsd)} · used ${money(credits.usedUsd)}</span>` : '<span class="muted">—</span>')}
        ${row("Reserve", "Studies never spend below this; each study's cap is clamped to the credit above it.", `${money(cfg.reserveUsd)} ${code("SWARM_CREDIT_RESERVE_USD")}`)}
        ${row("Screenshot width", "Images sent to the model are downscaled to save tokens.", `${cfg.imageMaxWidth}px ${code("SWARM_IMAGE_MAX_WIDTH")}`)}
      </div>
      <div class="card"><div class="card-head"><h2>${icon("cpu")} Models</h2></div>
        ${row("Agent steps", `Every persona step. Effort: ${esc(cfg.effort.step)}.`, `${code(cfg.models.step)} ${code("SWARM_STEP_MODEL")}`)}
        ${row("When stuck", `Takes over for 3 steps. Effort: ${esc(cfg.effort.escalation)}.`, `${code(cfg.models.escalation)} ${code("SWARM_ESCALATION_MODEL")}`)}
        ${row("Critic", `Reviews each session and proposes issues. Effort: ${esc(cfg.effort.critic)}.`, `${code(cfg.models.critic)} ${code("SWARM_CRITIC_MODEL")}`)}
        ${row("Synthesis", "Merges clusters that share a root cause.", `${code(cfg.models.synthesis)} ${code("SWARM_SYNTHESIS_MODEL")}`)}
        ${row("Success judge", "Only for fuzzy success rules.", `${code(cfg.models.judge)} ${code("SWARM_JUDGE_MODEL")}`)}
        ${row("Benchmark judge", "Scores the seeded-defect benchmark (rare, small).", `${code(cfg.models.benchmark)} ${code("SWARM_BENCHMARK_MODEL")}`)}
      </div>
      <div class="card"><div class="card-head"><h2>${icon("plug")} Integrations</h2></div>
        ${row("GitHub Issues", `${code("GITHUB_REPO")} ${code("GITHUB_TOKEN")}`, on(cfg.integrations?.github))}
        ${row("Jira", `${code("JIRA_BASE_URL")} ${code("JIRA_EMAIL")} ${code("JIRA_API_TOKEN")} ${code("JIRA_PROJECT_KEY")}`, on(cfg.integrations?.jira))}
        ${row("Linear", `${code("LINEAR_API_KEY")} ${code("LINEAR_TEAM_ID")}`, on(cfg.integrations?.linear))}
        <div class="setting"><div class="desc" style="grid-column:1/-1">Without credentials, "Send to" on an issue shows a ready-made ticket to copy instead.</div></div>
      </div>
      <div class="card"><div class="card-head"><h2>${icon("shield")} Access and safety</h2></div>
        ${row("Dashboard login", "Required to listen on anything but localhost.", on(cfg.auth, "Password required", "Off (localhost only)") + ` ${code("SWARM_PASSWORD")}`)}
        ${row("Listening on", "Bind address.", `${code(cfg.host)} ${code("SWARM_HOST")}`)}
        ${row("Politeness", "Maximum parallel browsers per target domain.", `${cfg.perDomainConcurrency} ${code("SWARM_PER_DOMAIN_CONCURRENCY")}`)}
        ${row("Evidence store", "Screenshots, replays, traces and the database.", code(cfg.dataDir))}
        <div class="setting"><div class="desc" style="grid-column:1/-1">Every study must confirm permission to test the site, stays inside its allowed domains, and honours the site's robots.txt by default.</div></div>
      </div>`}
    </div>`;
  const saveBtn = document.getElementById("save-key");
  saveBtn?.addEventListener("click", async () => {
    const input = document.getElementById("key");
    const msg = document.getElementById("key-msg");
    saveBtn.disabled = true;
    msg.textContent = "Checking with OpenRouter…";
    try {
      const r = await api.saveKey(input.value.trim());
      input.value = "";
      toast(`Key saved (···${r.last4})${r.remainingUsd != null ? ` · ${money(r.remainingUsd)} credit` : ""}`);
      await refreshMe(); refreshCredits(); render(view);
    } catch (e) { msg.textContent = e.message; msg.style.color = "var(--bad)"; saveBtn.disabled = false; }
  });
  document.getElementById("remove-key")?.addEventListener("click", async () => {
    if (!confirm("Remove your saved key? Studies that use it will stop until you add a key again.")) return;
    await api.removeKey(); toast("Key removed"); await refreshMe(); refreshCredits(); render(view);
  });
  document.getElementById("refresh")?.addEventListener("click", () => { refreshCredits(); render(view); });
}
