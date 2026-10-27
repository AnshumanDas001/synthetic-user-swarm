// ⌘K command palette: jump to pages, studies and issues.
import { api } from "./api.js";
import { esc, icon } from "./ui.js";

const ACTIONS = [
  { kind: "go", title: "Studies", sub: "All studies", href: "#/" },
  { kind: "go", title: "New study", sub: "Launch a swarm", href: "#/new" },
  { kind: "go", title: "Compare runs", sub: "Run diff between two studies", href: "#/compare" },
  { kind: "go", title: "Personas", sub: "Persona library", href: "#/personas" },
  { kind: "go", title: "Settings", sub: "Models, credit, integrations", href: "#/settings" },
];

export function openPalette() {
  if (document.querySelector(".palette-back")) return;
  const back = document.createElement("div");
  back.className = "palette-back";
  back.innerHTML = `<div class="palette" role="dialog" aria-modal="true" aria-label="Search">
    <input placeholder="Search studies and issues, or jump to a page…" aria-label="Search" autocomplete="off">
    <ul role="listbox"></ul>
    <div class="hint"><span><kbd>↑</kbd> <kbd>↓</kbd> move</span><span><kbd>↵</kbd> open</span><span><kbd>esc</kbd> close</span></div></div>`;
  document.body.appendChild(back);
  const input = back.querySelector("input");
  const ul = back.querySelector("ul");
  let items = [];
  let sel = 0;
  let timer = null;
  const close = () => { back.remove(); document.removeEventListener("keydown", onKey, true); };
  const go = (it) => { close(); location.hash = it.href; };
  const draw = () => {
    ul.innerHTML = items.length
      ? items.map((it, i) => `<li role="option" class="${i === sel ? "on" : ""}" data-i="${i}"><span class="k">${esc(it.kind)}</span><span class="t">${esc(it.title)}</span><span class="s">${esc(it.sub)}</span></li>`).join("")
      : `<li style="cursor:default"><span class="muted">${icon("search")} No matches</span></li>`;
    ul.querySelectorAll("li[data-i]").forEach((li) => {
      li.addEventListener("mouseenter", () => { sel = Number(li.dataset.i); draw(); });
      li.addEventListener("click", () => go(items[Number(li.dataset.i)]));
    });
    ul.querySelector(".on")?.scrollIntoView({ block: "nearest" });
  };
  const search = async () => {
    const q = input.value.trim().toLowerCase();
    const local = ACTIONS.filter((a) => !q || a.title.toLowerCase().includes(q));
    const remote = await api.get(`/api/search?q=${encodeURIComponent(q)}`).catch(() => []);
    items = [...local, ...remote];
    sel = 0;
    draw();
  };
  const onKey = (e) => {
    if (e.key === "Escape") { e.preventDefault(); close(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); sel = Math.min(items.length - 1, sel + 1); draw(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); sel = Math.max(0, sel - 1); draw(); }
    else if (e.key === "Enter" && items[sel]) { e.preventDefault(); go(items[sel]); }
  };
  document.addEventListener("keydown", onKey, true);
  back.addEventListener("click", (e) => { if (e.target === back) close(); });
  input.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(search, 120); });
  input.focus();
  search();
}
