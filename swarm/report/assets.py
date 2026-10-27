"""Static parts of the HTML report: its stylesheet and the replay page."""

REPORT_CSS = """
:root{--bg:#fbfaf8;--fg:#1c1c1e;--muted:#6b6b70;--card:#fff;--line:#e6e4df;--good:#3f9b5a;--bad:#d1453b;--na:#eee;--accent:#2f5bd3}
@media (prefers-color-scheme: dark){:root{--bg:#141416;--fg:#ececef;--muted:#9a9aa2;--card:#1d1d21;--line:#2e2e34;--na:#2a2a2e;--accent:#7fa0ff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
a{color:var(--accent)}code{font:13px ui-monospace,SFMono-Regular,Menlo,monospace}
.head{padding:24px 16px 8px;max-width:1100px;margin:0 auto}.head h1{margin:0 0 4px;font-size:26px}
.head nav{display:flex;gap:14px;flex-wrap:wrap;margin-top:8px;font-size:14px}main{max-width:1100px;margin:0 auto;padding:0 16px 64px}
section{margin-top:36px}h2{font-size:20px;border-bottom:1px solid var(--line);padding-bottom:6px}.muted{color:var(--muted)}.small{font-size:12px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px}.tile{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px}
.tile .big{font-size:28px;font-weight:650}.top li{margin:4px 0}
.scroll{overflow-x:auto}.matrix{border-collapse:separate;border-spacing:3px}.matrix td{min-width:88px;padding:8px;border-radius:6px;color:#fff;text-align:center;text-shadow:0 1px 1px rgba(0,0,0,.35)}
.matrix th{font-size:13px;font-weight:600;padding:4px;text-align:left}
.funnel .stage{display:grid;grid-template-columns:180px 1fr 90px;gap:10px;align-items:center;margin:4px 0}.bar{background:var(--na);border-radius:4px;height:18px;overflow:hidden}
.bar span{display:block;height:100%;background:var(--accent)}.drop{color:var(--bad);font-weight:600}
.issue{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin:16px 0}.issue h3{margin:0 0 6px;font-size:18px}
.meta{display:flex;gap:8px;flex-wrap:wrap;align-items:center;font-size:13px}
.sev{padding:2px 8px;border-radius:99px;font-weight:600;font-size:12px;color:#fff;background:#888}.sev-catastrophic{background:#a11d2b}.sev-major{background:#d1453b}.sev-minor{background:#d98a1c}.sev-cosmetic{background:#6b8e23}
.conf{padding:2px 8px;border-radius:99px;font-size:12px;border:1px solid var(--line)}.conf-high{border-color:var(--good)}.conf-low{border-color:var(--bad)}
.review{font-size:12px;color:var(--bad);font-weight:600}
dl{display:grid;grid-template-columns:90px 1fr;gap:2px 12px;font-size:14px}dt{color:var(--muted)}dd{margin:0}
.chip{display:inline-block;padding:1px 8px;border-radius:99px;background:var(--na);font-size:12px;margin:1px}
.diff-new{background:#fde2e0;color:#8a1c14}.diff-fixed{background:#dff3e4;color:#1f6b35}.diff-regressed{background:#fbe3c6;color:#7a4a00}
blockquote{margin:8px 0;padding:6px 12px;border-left:3px solid var(--accent);font-style:italic}
.strip{display:flex;gap:12px;overflow-x:auto;padding:8px 0;align-items:flex-start}.pair{margin:0;display:grid;grid-template-columns:1fr 1fr;gap:6px;min-width:420px;max-width:520px;align-items:start}
.pair figcaption{grid-column:1/-1;font-size:12px;color:var(--muted)}.shot{position:relative;border:1px solid var(--line);border-radius:6px;overflow:hidden;background:#fff}
.shot img{display:block;width:100%}.shot .cap{position:absolute;top:4px;left:4px;font-size:11px;background:rgba(0,0,0,.6);color:#fff;padding:0 5px;border-radius:4px}
.target{position:absolute;border:3px solid #ff2d55;border-radius:4px;box-shadow:0 0 0 2000px rgba(0,0,0,.12)}.noshot{padding:30px;text-align:center;color:var(--muted);font-size:12px}
.replay{font-size:12px;white-space:nowrap}.fix{background:var(--na);padding:8px 12px;border-radius:8px;font-size:14px}
table.plain{border-collapse:collapse;width:100%;font-size:14px}table.plain td,table.plain th{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}
.out{font-weight:600}.out-succeeded{color:var(--good)}.out-gave_up,.out-failed,.out-timed_out{color:var(--bad)}
@media print{.replay{display:none}.issue{break-inside:avoid}}
"""

REPLAY_HTML = """<!doctype html><html><head><meta charset="utf-8"><title>Session replay</title>
<link rel="stylesheet" href="player/rrweb-player.css"><style>body{margin:0;font:14px system-ui;background:#111;color:#eee}header{padding:10px 16px}a{color:#9cf}#p{display:flex;justify-content:center;padding:8px}</style></head>
<body><header><a href="index.html">← report</a> · <span id="t"></span></header><div id="p"></div>
<script src="player/rrweb-player.js"></script><script>

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
const q = new URLSearchParams(location.search); const id = q.get('session'); const t = Number(q.get('t') || 0);
document.getElementById('t').textContent = 'session ' + id + (t ? ' · starts at ' + (t/1000).toFixed(1) + 's' : '');
const s = document.createElement('script'); s.src = 'replays/' + id + '.js';
s.onload = () => { sanitizeReplay(window.__replay); const meta = window.__replay.find(e => e.type === 4); const w = Math.min(1100, (meta && meta.data.width) || 1024);
  const player = new rrwebPlayer({ target: document.getElementById('p'), props: { events: window.__replay, width: w, height: Math.round(w * ((meta && meta.data.height) || 768) / ((meta && meta.data.width) || 1024)), autoPlay: false, showController: true } });
  if (t) { player.goto(t, true); } };
document.body.appendChild(s);
</script></body></html>"""
