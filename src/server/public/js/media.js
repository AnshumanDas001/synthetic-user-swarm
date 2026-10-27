// Screenshot lightbox (with the tapped element boxed) and an inline rrweb session replay player.
import { esc, icon } from "./ui.js";

function modal(titleHtml) {
  const back = document.createElement("div");
  back.className = "modal-back";
  back.innerHTML = `<div class="modal" role="dialog" aria-modal="true"><div class="modal-head">${titleHtml}<span class="spacer"></span><button class="icon-btn" data-close aria-label="Close">${icon("x")}</button></div><div class="modal-body"></div></div>`;
  const close = () => { back.remove(); document.removeEventListener("keydown", onKey, true); };
  const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
  back.addEventListener("click", (e) => { if (e.target === back) close(); });
  back.querySelector("[data-close]").addEventListener("click", close);
  document.addEventListener("keydown", onKey, true);
  document.body.appendChild(back);
  return { body: back.querySelector(".modal-body"), close };
}

export function openLightbox(blobKey, caption, vbox) {
  const m = modal(`<b>${esc(caption)}</b>`);
  const box = vbox ? `<div class="target" style="left:${(vbox.x / vbox.vw) * 100}%;top:${(vbox.y / vbox.vh) * 100}%;width:${(vbox.width / vbox.vw) * 100}%;height:${(vbox.height / vbox.vh) * 100}%"></div>` : "";
  m.body.innerHTML = `<div style="text-align:center"><div class="lightbox"><img src="/blobs/${esc(blobKey)}" alt="${esc(caption)}">${box}</div></div>`;
}

// Click any [data-zoom] image inside root to open it large.
export function wireZoom(root) {
  root.querySelectorAll("[data-zoom]").forEach((el) => {
    el.classList.add("zoomable");
    el.addEventListener("click", (e) => {
      e.preventDefault();
      const vbox = el.dataset.vbox ? JSON.parse(el.dataset.vbox) : null;
      openLightbox(el.dataset.zoom, el.dataset.caption ?? "Screenshot", vbox);
    });
  });
}


// Strip <script> and preload/modulepreload/prefetch links from recorded DOM, so replays never fetch site code.
function sanitizeReplay(events) {
  const drop = (n) => n && n.type === 2 && (n.tagName === "script" || (n.tagName === "link" && /preload|prefetch|modulepreload/i.test(String(n.attributes && n.attributes.rel || ""))));
  const walk = (n) => { if (n && n.childNodes) { n.childNodes = n.childNodes.filter((c) => !drop(c)); n.childNodes.forEach(walk); } };
  for (const e of events) {
    if (e.type === 2 && e.data && e.data.node) walk(e.data.node);
    if (e.type === 3 && e.data && Array.isArray(e.data.adds)) e.data.adds = e.data.adds.filter((a) => !drop(a.node)).map((a) => (walk(a.node), a));
  }
  return events;
}

let playerLoaded = null;
function loadPlayer() {
  playerLoaded ??= new Promise((resolve, reject) => {
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = "/player/style.css";
    document.head.appendChild(css);
    const s = document.createElement("script");
    s.src = "/player/index.js";
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
  return playerLoaded;
}

// Opens the session replay in a modal, starting at `atMs` (epoch ms of the step), or at the start.
export async function openReplay(studyId, sessionId, title, atMs) {
  const m = modal(`${icon("film")}<b>${esc(title)}</b>`);
  m.body.innerHTML = `<div class="replay-host"><div class="muted" style="align-self:center">Loading replay…</div></div>`;
  try {
    const [events] = await Promise.all([fetch(`/api/studies/${studyId}/sessions/${sessionId}/replay`).then((r) => { if (!r.ok) throw new Error("No replay recorded for this session yet."); return r.json(); }), loadPlayer()]);
    sanitizeReplay(events);
    const host = m.body.querySelector(".replay-host");
    host.innerHTML = "";
    const meta = events.find((e) => e.type === 4);
    const vw = Math.min(window.innerWidth * 0.86, 1100);
    const ratio = ((meta?.data.height) || 768) / ((meta?.data.width) || 1024);
    const width = Math.round(Math.min(vw, (window.innerHeight * 0.66) / ratio));
    // eslint-disable-next-line no-undef
    const player = new rrwebPlayer({ target: host, props: { events, width, height: Math.round(width * ratio), autoPlay: !atMs, showController: true } });
    if (atMs) player.goto(Math.max(0, atMs - events[0].timestamp - 500), true);
  } catch (e) {
    m.body.innerHTML = `<div class="card card-body">${esc(e.message)}</div>`;
  }
}
