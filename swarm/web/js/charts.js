// Small SVG/HTML charts: donut for parts of a whole, horizontal bars for one measure across items.
import { esc } from "./ui.js";

export const OUTCOME_COLORS = { succeeded: "var(--good)", gave_up: "var(--warn)", failed: "var(--bad)", timed_out: "#9f1239", infra_error: "var(--muted)", running: "var(--accent)" };

export function donut(parts, centerText, centerSub) {
  const total = parts.reduce((a, p) => a + p.value, 0) || 1;
  const R = 52, C = 2 * Math.PI * R;
  let offset = 0;
  const arcs = parts.filter((p) => p.value > 0).map((p) => {
    const len = (p.value / total) * C;
    const el = `<circle r="${R}" cx="66" cy="66" fill="none" stroke="${p.color}" stroke-width="16" stroke-dasharray="${len} ${C - len}" stroke-dashoffset="${-offset}" transform="rotate(-90 66 66)"><title>${esc(p.label)}: ${p.value}</title></circle>`;
    offset += len;
    return el;
  }).join("");
  return `<div class="donut-wrap">
    <svg class="donut" viewBox="0 0 132 132" role="img" aria-label="${esc(parts.map((p) => `${p.label} ${p.value}`).join(", "))}">
      <circle r="${R}" cx="66" cy="66" fill="none" stroke="var(--surface-2)" stroke-width="16"/>${arcs}
      <text x="66" y="66" text-anchor="middle" class="center">${esc(centerText)}</text>
      <text x="66" y="84" text-anchor="middle" class="sub">${esc(centerSub)}</text>
    </svg>
    <div class="donut-legend">${parts.map((p) => `<span><i style="background:${p.color}"></i>${esc(p.label)} <b class="tnum">${p.value}</b></span>`).join("")}</div>
  </div>`;
}

// rows: [{label, value (0..1 or number), display}]; max defaults to 1 (rates).
export function hbars(rows, { max = 1, color = (v) => `color-mix(in oklab, var(--good) ${Math.round(v * 100)}%, var(--bad))` } = {}) {
  return `<div class="hbars">${rows.map((r) => `<div class="hbar"><span title="${esc(r.title ?? r.label)}" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.label)}</span>
    <div class="track"><div class="fill" style="width:${Math.max(r.value == null ? 0 : 2, ((r.value ?? 0) / max) * 100)}%;background:${r.value == null ? "transparent" : color(r.value / max)}"></div></div>
    <span class="v">${esc(r.display)}</span></div>`).join("")}</div>`;
}
