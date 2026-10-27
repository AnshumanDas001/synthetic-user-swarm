// App shell: hash router, sidebar state, credit card. Each page exports render(view, params) and may
// return a cleanup function (for event streams and timers).
import { api } from "./api.js";
import { $, $$, hydrateIcons, money } from "./ui.js";
import * as studies from "./pages/studies.js";
import * as newStudy from "./pages/new.js";
import * as study from "./pages/study.js";
import * as personas from "./pages/personas.js";
import * as compare from "./pages/compare.js";
import * as settings from "./pages/settings.js";
import { openPalette } from "./palette.js";

const routes = [
  [/^#?\/?$/, studies, "studies"],
  [/^#\/new$/, newStudy, "new"],
  [/^#\/personas$/, personas, "personas"],
  [/^#\/settings$/, settings, "settings"],
  [/^#\/compare(?:\/([\w-]+))?(?:\/([\w-]+))?$/, compare, "compare"],
  [/^#\/study\/([\w-]+)(?:\/(\w+))?(?:\/([\w-]+))?$/, study, "studies"],
];

let cleanup = null;

async function route() {
  if (typeof cleanup === "function") cleanup();
  cleanup = null;
  // Drawers belong to the page that opened them.
  $$(".drawer, .drawer-backdrop").forEach((el) => el.remove());
  const hash = location.hash || "#/";
  const match = routes.find(([re]) => re.test(hash)) ?? routes[0];
  const params = hash.match(match[0])?.slice(1) ?? [];
  $$(".nav a").forEach((a) => a.classList.toggle("active", a.dataset.nav === match[2]));
  $(".sidebar").classList.remove("open");
  const view = $("#view");
  $("#topbar-right").innerHTML = "";
  view.innerHTML = "";
  try {
    cleanup = await match[1].render(view, params);
  } catch (e) {
    view.innerHTML = `<div class="card card-body"><b>Something went wrong.</b> <span class="muted">${String(e.message)}</span></div>`;
  }
  hydrateIcons(document);
}

export function setCrumbs(parts) {
  $("#crumbs").innerHTML = parts.map((p, i) => (i < parts.length - 1 ? `<a href="${p[1]}">${p[0]}</a><span>/</span>` : `<b>${p[0]}</b>`)).join("");
}

// The signed-in user (null until loaded). Pages read it for plan, free runs and key status.
export let me = null;
export async function refreshMe() {
  me = await api.me().catch(() => null);
  const chip = $("#user-chip");
  if (me && me.mode === "google") {
    const pic = me.user.picture ? `<img src="${me.user.picture}" alt="" referrerpolicy="no-referrer">` : `<span class="avatar" style="background:var(--accent)">${(me.user.name || "?").slice(0, 1).toUpperCase()}</span>`;
    const plan = me.user.role === "admin" ? "Admin" : me.hasKey ? `Your key ···${me.keyLast4}` : me.freeRunsLeft > 0 ? `${me.freeRunsLeft} free run left` : "Free run used";
    chip.innerHTML = `${pic}<div style="min-width:0"><b>${me.user.name.replace(/[<>&]/g, "")}</b><div class="small muted" style="overflow:hidden;text-overflow:ellipsis">${me.user.email.replace(/[<>&]/g, "")}</div></div><span class="pill ${me.user.role === "admin" ? "accent" : me.hasKey || me.freeRunsLeft > 0 ? "good" : "warn"}" style="margin-left:auto">${plan}</span>`;
    chip.hidden = false;
  }
  if (me && me.mode !== "local") $("#signout").hidden = false;
  return me;
}

export async function refreshCredits() {
  const card = $("#credit-card");
  try {
    const [c, cfg] = await Promise.all([api.credits(), api.config()]);
    $("#mode-line").textContent = cfg.mode === "live" ? `Live · ${cfg.models.step}` : "Offline mode (mock policy)";
    if (c.scope === "none") {
      const left = c.freeRunsLeft ?? 0;
      card.innerHTML = `<div class="label">Your plan</div><div class="value">${left > 0 ? `${left} free run` : "Free run used"}</div>
        <div class="muted small">${left > 0 ? `Up to ${cfg.limits.freeMaxSessions} sessions on us.` : `<a href="#/settings">Add your OpenRouter key</a> to keep running studies.`}</div>`;
      return;
    }
    if (c.remainingUsd == null) {
      card.innerHTML = `<div class="label">Model credit</div><div class="value">${cfg.mode === "live" ? "No limit" : "Offline"}</div><div class="muted small">${cfg.mode === "live" ? "OpenRouter" : "No API calls are made"}</div>`;
      return;
    }
    const used = c.limitUsd ? (c.remainingUsd / c.limitUsd) * 100 : 100;
    card.innerHTML = `<div class="label">${c.scope === "own" ? "Your OpenRouter credit" : "OpenRouter credit"}</div><div class="value tnum">${money(c.remainingUsd)}</div>
      <div class="meter" title="${money(c.remainingUsd)} of ${money(c.limitUsd)} left"><span style="width:${Math.max(2, used)}%"></span></div>
      <div class="muted small" style="margin-top:6px">${c.limitUsd != null ? `of ${money(c.limitUsd)}` : ""}${c.scope === "own" ? " · your key" : ` · keeps ${money(c.reserveUsd)} in reserve`}</div>`;
  } catch {
    card.innerHTML = `<div class="label">Model credit</div><div class="muted small">Unavailable</div>`;
  }
}

$("#menu-btn").addEventListener("click", () => $(".sidebar").classList.toggle("open"));
$("#open-palette").addEventListener("click", openPalette);
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); openPalette(); }
  else if (e.key === "/" && !/input|textarea|select/i.test(document.activeElement?.tagName ?? "")) { e.preventDefault(); openPalette(); }
});
$("#signout").addEventListener("click", async () => { await api.post("/api/logout"); location.href = "/login"; });
await refreshMe();
window.addEventListener("hashchange", route);
hydrateIcons(document);
refreshCredits();
setInterval(refreshCredits, 60_000);
route();
