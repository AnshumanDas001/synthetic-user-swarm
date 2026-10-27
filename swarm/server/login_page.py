"""The sign-in page (Google button and, when SWARM_PASSWORD is set, an admin password form)."""
from __future__ import annotations

import os

GOOGLE_G = """<svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.3 0-9.7-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>"""

HEAD = """<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in · Swarm</title><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap">
<style>
:root{--bg:#f6f6f8;--card:#fff;--text:#17171c;--muted:#6b6b78;--border:#e4e4e9;--accent:#4f46e5}
@media (prefers-color-scheme:dark){:root{--bg:#0e0e12;--card:#17171d;--text:#ececf1;--muted:#8a8a98;--border:#2a2a33;--accent:#7c74ff}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:radial-gradient(1200px 600px at 50% -10%,color-mix(in oklab,var(--accent) 18%,transparent),transparent),var(--bg);color:var(--text);font:14px/1.5 Inter,system-ui,sans-serif;padding:16px}
.card{width:min(400px,100%);background:var(--card);border:1px solid var(--border);border-radius:16px;padding:30px;box-shadow:0 20px 50px -20px rgba(0,0,0,.25)}
.logo{width:42px;height:42px;border-radius:11px;background:var(--accent);position:relative;margin-bottom:18px}
.logo i{position:absolute;width:9px;height:9px;border-radius:50%;background:#fff}.logo i:nth-child(1){left:9px;top:11px}.logo i:nth-child(2){right:9px;top:11px;opacity:.7}.logo i:nth-child(3){left:16.5px;bottom:9px;opacity:.85}
h1{font-size:21px;margin:0 0 4px;letter-spacing:-.01em}p.sub{margin:0 0 22px;color:var(--muted)}
.google{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;height:44px;border-radius:10px;border:1px solid #dadce0;background:#fff;color:#1f1f1f;font:500 14.5px Inter,system-ui,sans-serif;text-decoration:none;box-shadow:0 1px 2px rgba(0,0,0,.06)}
.google:hover{background:#f8f9fa;box-shadow:0 1px 3px rgba(0,0,0,.12)}
.or{display:flex;align-items:center;gap:10px;color:var(--muted);font-size:12px;margin:20px 0}.or::before,.or::after{content:"";flex:1;height:1px;background:var(--border)}
label{display:block;font-weight:550;font-size:13px;margin-bottom:6px}
input{width:100%;height:40px;border-radius:9px;border:1px solid var(--border);background:var(--bg);color:var(--text);padding:0 12px;font:inherit}
input:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in oklab,var(--accent) 22%,transparent)}
button{margin-top:12px;width:100%;height:40px;border:0;border-radius:9px;background:var(--accent);color:#fff;font:600 14px Inter,system-ui,sans-serif;cursor:pointer}
.err{color:#dc2626;font-size:13px;min-height:20px;margin-top:12px}.fine{margin-top:18px;color:var(--muted);font-size:12px;line-height:1.5}
</style></head><body><div class="card">
<div class="logo"><i></i><i></i><i></i></div><h1>Sign in to Swarm</h1><p class="sub">Synthetic users that test your site and show you where real people would struggle.</p>
"""

TAIL = """</div>
<script>
const next = new URLSearchParams(location.search).get("next") || "/";
const g = document.getElementById("g"); if (g) g.href = "/auth/google?next=" + encodeURIComponent(next);
const f = document.getElementById("f");
if (f) f.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const r = await fetch("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: document.getElementById("p").value }) });
  if (r.ok) location.href = next.startsWith("/") && !next.startsWith("//") ? next : "/";
  else document.getElementById("e").textContent = (await r.json().catch(() => ({}))).error || "Sign-in failed";
});
</script></body></html>"""


def _esc(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


def login_html(mode: str, error: str) -> str:
    pw = bool(os.environ.get("SWARM_PASSWORD"))
    google = mode == "google"
    parts = [HEAD]
    if google:
        parts.append(f'<a class="google" id="g" href="/auth/google">{GOOGLE_G}<span>Sign in with Google</span></a>')
    parts.append("\n")
    if google and pw:
        parts.append('<div class="or">admin</div>')
    parts.append("\n")
    if pw:
        parts.append(f'<form id="f"><label for="p">{"Admin password" if google else "Password"}</label><input id="p" type="password" autocomplete="current-password" '
                     f'{"" if google else "autofocus"} required><button>Sign in</button></form>')
    parts.append(f'\n<div class="err" id="e" role="alert">{_esc(error)}</div>\n')
    if google:
        parts.append('<p class="fine">We use your Google name, email and photo only to keep your studies private to you. New accounts get one free run; '
                     "after that you can add your own OpenRouter API key.</p>")
    parts.append("\n" + TAIL)
    return "".join(parts)
