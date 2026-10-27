// Shared UI helpers: escaping, icons, formatting, badges, avatars, toasts, drawers.

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
export const $ = (sel, el = document) => el.querySelector(sel);
export const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

// Lucide-style 24px stroke icons.
const PATHS = {
  layers: '<path d="m12 2 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5"/><path d="m3 17 9 5 9-5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  play: '<path d="m6 4 14 8-14 8V4Z"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  file: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6Z"/><path d="M14 3v6h6M8 13h8M8 17h5"/>',
  external: '<path d="M14 4h6v6M20 4 10 14M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/>',
  alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  coins: '<circle cx="8" cy="8" r="6"/><path d="M18.1 10.4A6 6 0 1 1 10.4 18.1M7 6h1v4M16.7 13.9l.7.7-2.8 2.8"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  phone: '<rect x="6" y="2" width="12" height="20" rx="2"/><path d="M11 18h2"/>',
  monitor: '<rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>',
  keyboard: '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>',
  ear: '<path d="M6 8.5a6 6 0 1 1 12 0c0 6-6 6-6 10a3.5 3.5 0 0 1-6.5 1"/><path d="M15 8.5a3 3 0 1 0-6 0"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  zoom: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3M11 8v6M8 11h6"/>',
  lang: '<path d="m5 8 6 6M4 14l6-6 2-3M2 5h12M7 2h1M22 22l-5-10-5 10M14 18h6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  arrowRight: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  arrowLeft: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  share: '<path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7M16 6l-4-4-4 4M12 2v13"/>',
  sparkle: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5"/>',
  film: '<rect x="2" y="3" width="20" height="18" rx="2"/><path d="M7 3v18M17 3v18M2 8h5M2 16h5M17 8h5M17 16h5"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/>',
  diff: '<path d="M12 3v14M5 10h14M5 21h14"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>',
  download: '<path d="M12 3v12M7 10l5 5 5-5M5 21h14"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/>',
  cpu: '<rect x="5" y="5" width="14" height="14" rx="2"/><path d="M9 9h6v6H9zM9 1v4M15 1v4M9 19v4M15 19v4M1 9h4M1 15h4M19 9h4M19 15h4"/>',
  plug: '<path d="M9 2v6M15 2v6M6 8h12v4a6 6 0 0 1-12 0V8ZM12 18v4"/>',
};
export const icon = (name, cls = "i") => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${PATHS[name] ?? ""}</svg>`;
export function hydrateIcons(root = document) {
  for (const el of root.querySelectorAll("[data-icon]")) {
    el.outerHTML = icon(el.dataset.icon);
  }
}

// ---------- formatting
export const money = (n, d = 2) => (n == null ? "—" : `$${Number(n).toFixed(n > 0 && n < 0.01 ? 4 : d)}`);
export const pct = (x) => (x == null || Number.isNaN(x) ? "—" : `${Math.round(x * 100)}%`);
export const secs = (ms) => {
  if (!ms) return "—";
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};
export function ago(t) {
  if (!t) return "—";
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
export const human = (s) => String(s ?? "").replace(/_/g, " ");
export const hostPath = (url) => { try { const u = new URL(url); return u.host + (u.pathname === "/" ? "" : u.pathname); } catch { return url; } };

// ---------- severity / status
export function sevClass(s) {
  return s >= 3.5 ? "critical" : s >= 2.5 ? "major" : s >= 1.5 ? "minor" : "cosmetic";
}
export const sevBadge = (s) => `<span class="sev ${sevClass(s)}">${Number(s).toFixed(1)} ${sevClass(s)}</span>`;
export const confBadge = (c, review) => `<span class="pill ${c === "high" ? "good" : c === "medium" ? "info" : "warn"}">${esc(c)} confidence</span>${review ? ` <span class="pill warn">${icon("alert")} needs review</span>` : ""}`;

const STATUS = {
  running: ["live accent", "Running"], provisioning: ["accent", "Starting"], queued: ["", "Queued"], planned: ["", "Planned"],
  complete: ["good", "Complete"], stopped: ["warn", "Stopped"], succeeded: ["good", "Succeeded"], gave_up: ["warn", "Gave up"],
  failed: ["bad", "Failed"], timed_out: ["bad", "Timed out"], infra_error: ["", "Infra error"], analysed: ["info", "Analysed"],
};
export function statusPill(status) {
  const [cls, label] = STATUS[status] ?? ["", status];
  return `<span class="pill ${cls}"><span class="dot"></span>${esc(label)}</span>`;
}

// Outcome bar: succeeded / gave up / failed / running / infra.
export function outcomeBar(sessions) {
  const n = sessions.length || 1;
  const count = (f) => sessions.filter(f).length;
  const o = (s) => s.outcome ?? s.status;
  const parts = [
    ["ok", count((s) => o(s) === "succeeded")],
    ["gu", count((s) => o(s) === "gave_up")],
    ["ko", count((s) => ["failed", "timed_out"].includes(o(s)))],
    ["inf", count((s) => o(s) === "infra_error")],
    ["run", count((s) => ["running", "provisioning"].includes(s.status))],
  ];
  return `<div class="progress">${parts.map(([c, v]) => (v ? `<span class="${c}" style="width:${(v / n) * 100}%"></span>` : "")).join("")}</div>`;
}

// ---------- avatars
const HUES = [250, 200, 160, 20, 330, 280, 40, 180, 0, 300, 120, 220];
export function avatar(name, id, size = "") {
  const h = HUES[[...String(id ?? name)].reduce((a, c) => a + c.charCodeAt(0), 0) % HUES.length];
  return `<span class="avatar ${size}" style="background:hsl(${h} 55% 48%)">${esc(String(name ?? "?").slice(0, 1).toUpperCase())}</span>`;
}

export function personaTraits(p) {
  const t = [];
  t.push(p.mobile || p.device?.touch ? `<span class="chip">${icon("phone")}${esc(p.device.viewport)}</span>` : `<span class="chip">${icon("monitor")}${esc(p.device.viewport)}</span>`);
  if (p.accessibility?.screen_reader) t.push(`<span class="chip">${icon("ear")}Screen reader</span>`);
  else if (p.accessibility?.keyboard_only) t.push(`<span class="chip">${icon("keyboard")}Keyboard only</span>`);
  if (p.accessibility?.zoom > 100) t.push(`<span class="chip">${icon("zoom")}${p.accessibility.zoom}%</span>`);
  if (p.accessibility?.color_vision && p.accessibility.color_vision !== "normal") t.push(`<span class="chip">${icon("eye")}${esc(p.accessibility.color_vision)}</span>`);
  if (p.non_native) t.push(`<span class="chip">${icon("lang")}${esc(p.locale)}</span>`);
  if (p.device?.network && p.device.network !== "fast") t.push(`<span class="chip">${esc(p.device.network)}</span>`);
  return t.join("");
}
export const personaTag = (p) =>
  p.accessibility?.screen_reader ? "Screen reader" : p.accessibility?.keyboard_only ? "Keyboard" : p.mobile ? "Mobile" : p.non_native ? "Non-native" : "Desktop";
export const bar5 = (n) => `<span class="bar5" title="${n}/5">${[1, 2, 3, 4, 5].map((i) => `<i class="${i <= n ? "on" : ""}"></i>`).join("")}</span>`;

// ---------- feedback
export function toast(msg, kind = "") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = msg;
  document.getElementById("toasts").appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

export function empty(iconName, title, text, action = "") {
  return `<div class="empty"><div class="art">${icon(iconName)}</div><h3>${esc(title)}</h3><p>${esc(text)}</p>${action}</div>`;
}

// Side drawer; returns { body, close }.
export function drawer(titleHtml, onClose) {
  const back = document.createElement("div");
  back.className = "drawer-backdrop";
  const d = document.createElement("aside");
  d.className = "drawer";
  d.setAttribute("role", "dialog");
  d.setAttribute("aria-modal", "true");
  d.innerHTML = `<div class="drawer-head">${titleHtml}<span class="spacer"></span><button class="icon-btn" data-close aria-label="Close">${icon("x")}</button></div><div class="drawer-body"></div>`;
  const close = () => { back.remove(); d.remove(); document.removeEventListener("keydown", onKey); onClose?.(); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  back.addEventListener("click", close);
  d.querySelector("[data-close]").addEventListener("click", close);
  document.addEventListener("keydown", onKey);
  document.body.append(back, d);
  d.querySelector("[data-close]").focus();
  return { body: d.querySelector(".drawer-body"), close };
}

// Screenshot with the action's target boxed (percent of the viewport the box was measured in).
export function frame(blobKey, label, vbox) {
  if (!blobKey) return `<div class="frame"><div class="skeleton" style="aspect-ratio:16/10"></div><span class="cap">${esc(label)}</span></div>`;
  const box = vbox ? `<div class="target" style="left:${(vbox.x / vbox.vw) * 100}%;top:${(vbox.y / vbox.vh) * 100}%;width:${(vbox.width / vbox.vw) * 100}%;height:${(vbox.height / vbox.vh) * 100}%"></div>` : "";
  return `<div class="frame"><img src="/blobs/${esc(blobKey)}" alt="${esc(label)} screenshot" loading="lazy" data-zoom="${esc(blobKey)}" data-caption="${esc(label)}"${vbox ? ` data-vbox='${esc(JSON.stringify(vbox))}'` : ""}>${box}<span class="cap">${esc(label)}</span></div>`;
}
