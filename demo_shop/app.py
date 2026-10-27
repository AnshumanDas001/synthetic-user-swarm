"""'Kindling & Co.' demo shop with 14 seeded usability defects (see defects.py).
Run: python -m demo_shop  (DEFECTS=all|none|D01,D04 ; PORT=4400)
Admin: GET/POST /__defects  {id, enabled} or {all}  ·  POST /__reset"""
from __future__ import annotations

import asyncio
import os
import random
import re
import secrets

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse

from .defects import DEFECTS, DefectSwitchboard

PRODUCTS = [
    {"id": 1, "name": "Hand-poured soy candle", "price": 24, "sku": "KC-CND-0114", "blurb": "Cedar and orange, burns for 40 hours. Comes in a recycled glass jar.", "tags": ["gift", "birthday", "home", "present"]},
    {"id": 2, "name": "Merino wool scarf", "price": 38, "sku": "KC-SCF-0221", "blurb": "Soft, warm and machine washable. Available in blue, grey and rust.", "tags": ["gift", "winter", "present", "clothing"]},
    {"id": 3, "name": "Ceramic coffee mug", "price": 18, "sku": "KC-MUG-0307", "blurb": "Hand-thrown stoneware mug, 350 ml, dishwasher safe.", "tags": ["gift", "kitchen", "birthday", "present"]},
    {"id": 4, "name": "Wireless earbuds", "price": 39, "sku": "KC-AUD-0412", "blurb": "Twelve hours of battery life and a pocket-sized charging case.", "tags": ["gift", "teen", "teenager", "tech", "birthday", "present"]},
    {"id": 5, "name": "Sketchbook and pencil set", "price": 22, "sku": "KC-ART-0519", "blurb": "A5 sketchbook with six graphite pencils and an eraser.", "tags": ["gift", "teen", "teenager", "art", "present"]},
    {"id": 6, "name": "Leather weekend bag", "price": 129, "sku": "KC-BAG-0623", "blurb": "Full-grain leather holdall with brass fittings.", "tags": ["travel"]},
    {"id": 7, "name": "Board game: Harbour Lights", "price": 34, "sku": "KC-GME-0731", "blurb": "A family strategy game for 2 to 5 players, ages 10 and up.", "tags": ["gift", "teen", "teenager", "family", "present", "birthday"]},
    {"id": 8, "name": "Linen table runner", "price": 45, "sku": "KC-LIN-0845", "blurb": "Stonewashed linen, 180 cm long.", "tags": ["home"]},
]
BY_ID = {p["id"]: p for p in PRODUCTS}

defects = DefectSwitchboard()
bags: dict[str, dict[int, int]] = {}
orders: dict[str, dict] = {}
subscribers: set[str] = set()


def D(id: str) -> bool:
    return defects.has(id)


def esc(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


def money(n: float) -> str:
    return f"${n:.2f}"


def bag_of(sid: str) -> dict[int, int]:
    return bags.setdefault(sid, {})


def bag_count(sid: str) -> int:
    return sum(bag_of(sid).values())


SEARCH_ICON = '<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="2"/><path d="M20 20l-4-4" stroke="currentColor" stroke-width="2"/></svg>'

CSS = """
*{box-sizing:border-box}body{margin:0;font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1d1d1f;background:#fbfaf7}
a{color:#7a3e12}main{max-width:960px;margin:0 auto;padding:16px 16px 180px}
.top{display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between;padding:12px 16px;background:#fff;border-bottom:1px solid #eee}
.logo{font-weight:700;text-decoration:none;color:#1d1d1f;font-size:18px}.search{display:flex;gap:4px}.search input{padding:6px 8px;border:1px solid #ccc;border-radius:6px;width:150px}
.icon-btn{border:1px solid #ccc;background:#fff;border-radius:6px;padding:4px 8px;cursor:pointer}nav a{margin-left:12px}
.btn{display:inline-block;background:#b5541b;color:#fff;border:0;border-radius:8px;padding:10px 16px;font-size:16px;text-decoration:none;cursor:pointer}
.btn-small{padding:6px 10px;font-size:14px}.btn-wide{padding:14px 28px;font-size:18px}.btn-ghost{background:#eee;color:#333}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:16px}.card{background:#fff;border:1px solid #eee;border-radius:10px;padding:12px}
.card a{text-decoration:none;color:inherit}.card h3{font-size:15px;margin:8px 0 4px}.ph{height:110px;border-radius:8px;background:#f1e4d6;display:flex;align-items:center;justify-content:center;font-size:40px;color:#b5541b}
.ph.big{height:240px;font-size:90px}.price{font-weight:600}.pdp{display:grid;grid-template-columns:1fr 1fr;gap:24px}@media(max-width:700px){.pdp{grid-template-columns:1fr}}
.meta{color:#666;font-size:13px}.note{color:#444;font-size:14px}.faint{color:#d0d0d0;font-size:13px}.faint-link{color:#cfcfcf;font-size:13px}.link{font-size:15px}
.toast{background:#e8f5e9;border:1px solid #a5d6a7;padding:8px;border-radius:6px}.hero{background:#fff;border-radius:12px;padding:24px;margin-bottom:16px}
.promo{background:#2d2d2d;color:#fff;padding:22px 16px;border-radius:8px;margin:12px 0}
table.bag{width:100%;border-collapse:collapse;background:#fff}table.bag td,table.bag th{padding:8px;border-bottom:1px solid #eee;text-align:left}
.total{font-size:18px}.coupon{margin:16px 0}.actions{margin-top:24px;display:flex;gap:16px;align-items:center;flex-wrap:wrap}
.sticky-actions{margin-top:24px;display:flex;gap:16px;align-items:center;flex-wrap:wrap}
@media(max-width:600px){.sticky-actions{position:fixed;left:0;right:0;bottom:0;background:#fff;padding:12px 16px;border-top:1px solid #ddd;z-index:10}}
form label{display:block;margin-top:10px;font-size:14px}form input{width:100%;max-width:420px;padding:9px;border:1px solid #bbb;border-radius:6px;font-size:16px;margin-top:4px}
#co input{display:block}.error{color:#b00020;font-size:14px}.tiny{font-size:12px;margin-top:40px}
footer{max-width:960px;margin:0 auto;padding:16px;color:#555;font-size:14px}footer input{width:200px;display:inline-block}footer label{display:inline}
.cookie{position:fixed;left:0;right:0;z-index:50;background:#20232a;color:#fff}.cookie.big{bottom:0;padding:16px}.cookie.big p{margin:0 0 8px;font-size:14px}
.cookie.slim{position:static;padding:8px 16px;font-size:13px;display:flex;gap:8px;align-items:center;justify-content:center}.cookie .small-link{color:#aaa;font-size:12px}
.modal-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;z-index:60}.modal-backdrop[hidden]{display:none}
.modal{background:#fff;border-radius:12px;padding:24px;max-width:360px;width:90%;position:relative}.close-x{position:absolute;right:10px;top:6px;font-size:22px;cursor:pointer;background:none;border:0}
"""

CLIENT_BASE = r"""
function acceptCookies(){document.cookie='cookies=1;path=/';var b=document.getElementById('cookie-banner');if(b)b.remove();}
if(document.cookie.indexOf('cookies=1')>=0){var cb=document.getElementById('cookie-banner');if(cb)cb.remove();}
function subscribe(id){var v=document.getElementById(id).value;fetch('/api/subscribe',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:v})}).then(function(r){return r.json()}).then(function(j){var m=document.getElementById('ft-msg');if(m)m.textContent=j.ok?"You're subscribed! Your code is WELCOME10.":"Please enter a valid email.";var nl=document.getElementById('nl');if(nl&&j.ok){nl.querySelector('.modal').innerHTML='<h2>Thanks!</h2><p>You\'re subscribed! Your code is WELCOME10.</p><button class=\"btn\" onclick=\"closeNl()\">Close</button>';}});}
function closeNl(){var nl=document.getElementById('nl');if(nl){nl.hidden=true;document.cookie='nl=1;path=/';}}
"""

# D09: the newsletter pop-up opens after 1.5 s and traps Tab between its two fields; Escape does nothing.
CLIENT_D09 = r"""
if(document.cookie.indexOf('nl=1')<0){setTimeout(function(){var nl=document.getElementById('nl');nl.hidden=false;var f=nl.querySelectorAll('input,button');f[0]&&f[0].focus();
 nl.addEventListener('keydown',function(e){
  if(e.key==='Tab'){e.preventDefault();var a=document.getElementById('nl-email'),b=document.getElementById('nl-go');(document.activeElement===a?b:a).focus();}
 });},1500);}"""


def client_js(home: bool) -> str:
    return CLIENT_BASE + (CLIENT_D09 if home and D("D09") else "") + "\n"


def layout(sid: str, title: str, body: str, home: bool = False) -> str:
    count = bag_count(sid)
    if D("D01"):
        cookie = ('<div id="cookie-banner" class="cookie big" role="region" aria-label="Cookie notice"><p>We use cookies to improve your experience, personalise content and ads, '
                  'provide social media features and analyse our traffic. By continuing you agree to our use of cookies.</p><div><button class="btn" onclick="acceptCookies()">Accept all</button> '
                  '<a href="#" onclick="acceptCookies();return false" class="small-link">Manage</a></div></div>')
    else:
        cookie = '<div id="cookie-banner" class="cookie slim" role="region" aria-label="Cookie notice"><span>We use cookies.</span> <button class="btn btn-small" onclick="acceptCookies()">OK</button></div>'
    newsletter = ""
    if home:
        if D("D09"):
            newsletter = ('<div id="nl" class="modal-backdrop" hidden><div class="modal" role="dialog" aria-modal="true" aria-labelledby="nl-title"><span class="close-x" onclick="closeNl()">×</span>'
                          '<h2 id="nl-title">Get 10% off</h2><p>Join our newsletter for a welcome code.</p><input id="nl-email" type="email" placeholder="Email address">'
                          '<button class="btn" id="nl-go" onclick="subscribe(\'nl-email\')">Subscribe</button></div></div>')
        else:
            newsletter = ('<div id="nl" class="modal-backdrop" hidden><div class="modal" role="dialog" aria-modal="true" aria-labelledby="nl-title"><button class="close-x" aria-label="Close" onclick="closeNl()">×</button>'
                          '<h2 id="nl-title">Get 10% off</h2><p>Join our newsletter for a welcome code.</p><label for="nl-email">Email address</label><input id="nl-email" type="email">'
                          '<button class="btn" id="nl-go" onclick="subscribe(\'nl-email\')">Subscribe</button></div></div>')
    search_label = "" if D("D03") else 'aria-label="Search products"'
    button_label = "" if D("D03") else 'aria-label="Search"'
    return (
        '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">\n'
        f"<title>{esc(title)} · Kindling &amp; Co.</title><style>{CSS}</style></head><body>\n"
        '<header class="top"><a href="/" class="logo">Kindling &amp; Co.</a>\n'
        f'<form action="/search" class="search" role="search"><input name="q" type="search" placeholder="Search" {search_label}><button type="submit" class="icon-btn" {button_label}>{SEARCH_ICON}</button></form>\n'
        f'<nav><a href="/products">Shop</a> <a href="/bag" id="bag-link">Bag (<span id="bag-count">{count}</span>)</a></nav></header>\n'
        f"<main>{body}</main>\n"
        "<footer><p>Kindling &amp; Co. · Small things, made well.</p><form onsubmit=\"subscribe('ft-email');return false\"><label for=\"ft-email\">Newsletter</label> "
        '<input id="ft-email" type="email" placeholder="you@example.com"> <button class="btn btn-small">Subscribe</button></form><p id="ft-msg" role="status"></p></footer>\n'
        f"{cookie}{newsletter}\n"
        f"<script>{client_js(home)}</script></body></html>"
    )


def card(p: dict) -> str:
    return (f'<article class="card"><a href="/products/{p["id"]}"><div class="ph" aria-hidden="true">{p["name"][0]}</div><h3>{esc(p["name"])}</h3></a>'
            f'<p class="price">{money(p["price"])}</p></article>')


app = FastAPI(title="Kindling & Co. demo shop", docs_url=None, redoc_url=None, openapi_url=None)


@app.middleware("http")
async def session_cookie(request: Request, call_next):
    sid = request.cookies.get("sid")
    fresh = not sid or not re.fullmatch(r"[a-f0-9]+", sid)
    if fresh:
        sid = secrets.token_hex(8)
    request.state.sid = sid
    response = await call_next(request)
    if fresh:
        response.headers.append("set-cookie", f"sid={sid}; Path=/; SameSite=Lax")
    return response


def html(body: str, status: int = 200) -> HTMLResponse:
    return HTMLResponse(body, status_code=status)


@app.get("/")
async def home(request: Request):
    featured = "".join(card(p) for p in PRODUCTS[:4])
    return html(layout(request.state.sid, "Home",
                       '<section class="hero"><h1>Thoughtful gifts, made by hand</h1><p>Small-batch goods from independent makers. Free delivery over $50.</p>'
                       f'<a class="btn" href="/products">Shop all gifts</a></section><h2>Featured</h2><div class="grid">{featured}</div>', home=True))


@app.get("/products")
async def products(request: Request):
    if D("D11"):
        promo = ('<div id="promo-slot"></div><script>setTimeout(function(){document.getElementById(\'promo-slot\').innerHTML=\'<div class="promo">'
                 'Autumn sale: 15% off candles this week only</div>\'},1200)</script>')
    else:
        promo = '<div class="promo">Autumn sale: 15% off candles this week only</div>'
    return html(layout(request.state.sid, "Shop", f'<h1>All products</h1>{promo}<div class="grid">{"".join(card(p) for p in PRODUCTS)}</div>'))


@app.get("/products/{pid}")
async def product(request: Request, pid: str):
    sid = request.state.sid
    p = BY_ID.get(int(pid)) if pid.isdigit() else None
    if not p:
        return html(layout(sid, "Not found", "<h1>Product not found</h1>"), 404)
    sku = f'<p class="meta">SKU: {p["sku"]} · RRP {money(p["price"] * 1.2)}</p>' if D("D07") else ""
    post = ("fetch('/api/bag',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({productId:" + str(p["id"])
            + ",qty:Number(document.getElementById('qty').value)})})")
    feedback = post + ";" if D("D02") else (
        post + ".then(function(r){return r.json()}).then(function(j){document.getElementById('bag-count').textContent=j.count;"
        "var t=document.getElementById('toast');t.innerHTML='Added to your bag. <a href=\"/bag\">View bag</a>';t.hidden=false;});")
    return html(layout(sid, p["name"],
                       f'<div class="pdp"><div class="ph big" aria-hidden="true">{p["name"][0]}</div><div><h1>{esc(p["name"])}</h1><p class="price">{money(p["price"])}</p>{sku}<p>{esc(p["blurb"])}</p>\n'
                       '<label for="qty">Quantity</label> <select id="qty"><option>1</option><option>2</option><option>3</option></select>\n'
                       f'<p><button class="btn" id="add" onclick="{esc(feedback)}">Add to bag</button></p><p id="toast" class="toast" role="status" hidden></p>\n'
                       f'<p class="{"faint" if D("D06") else "note"}">Delivery in 3–5 working days. Free over $50.</p></div></div>'))


@app.get("/search")
async def search(request: Request, q: str = ""):
    q = q.strip().lower()
    words = q.split()

    def matches(p: dict) -> bool:
        return all(w in p["name"].lower() or (not D("D08") and any(t.startswith(re.sub(r"s$", "", w)) for t in p["tags"])) for w in words)

    hits = [p for p in PRODUCTS if words and matches(p)]
    body = (f'<h1>Results for “{esc(q)}”</h1><div class="grid">{"".join(card(p) for p in hits)}</div>' if hits
            else f"<h1>Results for “{esc(q)}”</h1><p>No results found. Try a different search.</p>")
    return html(layout(request.state.sid, "Search", body))


@app.get("/bag")
async def bag(request: Request):
    sid = request.state.sid
    lines = [(BY_ID[pid], qty) for pid, qty in bag_of(sid).items()]
    total = sum(p["price"] * q for p, q in lines)
    if not lines:
        return html(layout(sid, "Your bag", '<h1>Your bag</h1><p>Your bag is empty.</p><a class="btn" href="/products">Start shopping</a>'))
    rows = "".join(f'<tr><td>{esc(p["name"])}{"<br><small>SKU " + p["sku"] + "</small>" if D("D07") else ""}</td><td>{q}</td><td>{money(p["price"] * q)}</td></tr>' for p, q in lines)
    total_label = "Cart subtotal excl. VAT" if D("D07") else "Total"
    apply_js = "" if D("D12") else ('onclick="var v=document.getElementById(\'coupon\').value.trim().toUpperCase();document.getElementById(\'cmsg\').textContent='
                                    "v==='WELCOME10'?'Code applied: 10% off at checkout.':'That code is not valid.'\"")
    coupon = f'<div class="coupon"><label for="coupon">Promo code</label> <input id="coupon"> <button class="btn btn-small btn-ghost" id="apply" {apply_js}>Apply</button><p id="cmsg" role="status"></p></div>'
    if D("D05"):
        actions = (f'<div class="{"sticky-actions" if D("D01") else "actions"}"><a class="btn btn-wide" href="/products">Continue shopping</a> '
                   f'<a class="{"faint-link" if D("D06") else "link"}" href="/checkout">Checkout</a></div>')
    else:
        actions = '<div class="actions"><a class="btn btn-wide" href="/checkout">Checkout</a> <a class="link" href="/products">Continue shopping</a></div>'
    return html(layout(sid, "Your bag",
                       f'<h1>Your bag</h1><table class="bag"><thead><tr><th>Item</th><th>Qty</th><th>Price</th></tr></thead><tbody>{rows}</tbody></table>\n'
                       f'<p class="total"><strong>{total_label}: {money(total)}</strong></p><p class="{"faint" if D("D06") else "note"}">Delivery calculated at the next step.</p>{coupon}{actions}'))


@app.get("/checkout")
async def checkout(request: Request, mode: str = ""):
    sid = request.state.sid
    if not bag_count(sid):
        return RedirectResponse("/bag", status_code=302)
    mode = mode or ("account" if D("D10") else "guest")

    def lbl(id: str, text: str, type: str = "text", auto: str = "") -> str:
        if D("D13") and id in ("address", "city", "zip"):
            return f'<input id="{id}" name="{id}" type="{type}" placeholder="{text}" {auto}>'
        return f'<label for="{id}">{text}</label><input id="{id}" name="{id}" type="{type}" {auto}>'

    if mode == "account":
        return html(layout(sid, "Checkout",
                           '<h1>Create an account to continue</h1><p>Members get faster checkout and order tracking.</p>\n'
                           "<form id=\"acct\" onsubmit=\"event.preventDefault();document.getElementById('amsg').textContent='Please choose a stronger password (12+ characters, a symbol and a number).'\">\n"
                           '<label for="a-email">Email</label><input id="a-email" type="email" autocomplete="email"><label for="a-pass">Password</label><input id="a-pass" type="password">'
                           '<button class="btn">Create account</button><p id="amsg" role="alert"></p></form>\n'
                           f'<p class="tiny"><a class="{"faint-link" if D("D06") else "link"}" href="/checkout?mode=guest">or continue without an account</a></p>'))
    if D("D04"):
        phone_check = r"if(!/^\+1 \(\d{3}\) \d{3}-\d{4}$/.test(f.phone.value)){return;}"
    else:
        phone_check = (r"if(f.phone.value.replace(/\D/g,'').length<10){var m=document.getElementById('pmsg');m.textContent='Please enter a 10-digit phone number, e.g. 555 123 4567.';"
                       r"f.phone.setAttribute('aria-invalid','true');return;}")
    placing = "" if D("D14") else "var b=document.getElementById('place');b.disabled=true;b.textContent='Placing order…';"
    return html(layout(sid, "Checkout",
                       '<h1>Checkout</h1><form id="co" novalidate onsubmit="event.preventDefault();submitOrder(this)">\n'
                       f'{lbl("name", "Full name", "text", "autocomplete=\"name\"")}{lbl("email", "Email", "email", "autocomplete=\"email\"")}\n'
                       '<label for="phone">Phone</label><input id="phone" name="phone" type="tel" autocomplete="tel"><p id="pmsg" class="error" role="alert"></p>\n'
                       f'{lbl("address", "Street address")}{lbl("city", "City")}{lbl("zip", "ZIP code")}\n'
                       '<p class="note">Payment is taken on delivery (test shop).</p><button class="btn btn-wide" id="place">Place order</button></form>\n'
                       f"<script>function submitOrder(f){{ {phone_check} {placing}\n"
                       "fetch('/api/orders',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:f.name.value})})"
                       ".then(function(r){return r.json()}).then(function(j){location.href='/order/'+j.id;});}</script>"))


@app.get("/order/{oid}")
async def order(request: Request, oid: str):
    sid = request.state.sid
    o = orders.get(oid)
    if not o:
        return html(layout(sid, "Order", "<h1>Order not found</h1>"), 404)
    return html(layout(sid, "Order confirmed",
                       f'<h1>Order confirmed</h1><p>Thank you for your order. Your order number is <strong>{esc(oid)}</strong>. Total {money(o["total"])}.</p>'
                       '<a class="btn" href="/">Back to the shop</a>'))


async def _json(request: Request) -> dict:
    try:
        body = await request.json()
        return body if isinstance(body, dict) else {}
    except Exception:
        return {}


@app.post("/api/bag")
async def add_to_bag(request: Request):
    body = await _json(request)
    try:
        pid = int(body.get("productId"))
    except (TypeError, ValueError):
        pid = -1
    if pid not in BY_ID:
        return JSONResponse({"error": "unknown product"}, status_code=400)
    try:
        qty = max(1, int(body.get("qty") or 1))
    except (TypeError, ValueError):
        qty = 1
    b = bag_of(request.state.sid)
    b[pid] = b.get(pid, 0) + qty
    return {"ok": True, "count": bag_count(request.state.sid)}


@app.post("/api/orders")
async def place_order(request: Request):
    sid = request.state.sid
    b = bag_of(sid)
    if not b:
        return JSONResponse({"error": "empty bag"}, status_code=400)
    await asyncio.sleep(3.5 if D("D14") else 0.5)
    oid = f"KC{random.randint(100000, 999999)}"
    items = list(b.items())
    orders[oid] = {"items": items, "total": sum(BY_ID[pid]["price"] * q for pid, q in items)}
    bags.pop(sid, None)
    return JSONResponse({"id": oid}, status_code=201)


@app.post("/api/subscribe")
async def subscribe(request: Request):
    email = str((await _json(request)).get("email") or "")
    ok = bool(re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email))
    if ok:
        subscribers.add(email)
    return {"ok": ok}


# ---------------------------------------------------------------- admin (benchmark control)

@app.get("/__defects")
async def list_defects():
    return defects.list()


@app.post("/__defects")
async def set_defects(request: Request):
    body = await _json(request)
    if "all" in body:
        for d in DEFECTS:
            defects.set(d["id"], bool(body["all"]))
    else:
        defects.set(str(body.get("id", "")).upper(), bool(body.get("enabled")))
    return defects.list()


@app.post("/__reset")
async def reset():
    orders.clear()
    return {"ok": True}


def enabled_ids() -> str:
    return ",".join(d["id"] for d in defects.list() if d["enabled"]) or "none"
