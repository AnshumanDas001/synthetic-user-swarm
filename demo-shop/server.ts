// "Kindling & Co." demo shop with 14 seeded usability defects (see defects.ts).
// Run: npm run shop  (DEFECTS=all|none|D01,D04 ; PORT=4400)
// Admin: GET/POST /__defects  {id, enabled}  ·  POST /__reset
import express from "express";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { DefectSwitchboard, DEFECTS } from "./defects.js";

interface Product { id: number; name: string; price: number; sku: string; blurb: string; tags: string[] }

const PRODUCTS: Product[] = [
  { id: 1, name: "Hand-poured soy candle", price: 24, sku: "KC-CND-0114", blurb: "Cedar and orange, burns for 40 hours. Comes in a recycled glass jar.", tags: ["gift", "birthday", "home", "present"] },
  { id: 2, name: "Merino wool scarf", price: 38, sku: "KC-SCF-0221", blurb: "Soft, warm and machine washable. Available in blue, grey and rust.", tags: ["gift", "winter", "present", "clothing"] },
  { id: 3, name: "Ceramic coffee mug", price: 18, sku: "KC-MUG-0307", blurb: "Hand-thrown stoneware mug, 350 ml, dishwasher safe.", tags: ["gift", "kitchen", "birthday", "present"] },
  { id: 4, name: "Wireless earbuds", price: 39, sku: "KC-AUD-0412", blurb: "Twelve hours of battery life and a pocket-sized charging case.", tags: ["gift", "teen", "teenager", "tech", "birthday", "present"] },
  { id: 5, name: "Sketchbook and pencil set", price: 22, sku: "KC-ART-0519", blurb: "A5 sketchbook with six graphite pencils and an eraser.", tags: ["gift", "teen", "teenager", "art", "present"] },
  { id: 6, name: "Leather weekend bag", price: 129, sku: "KC-BAG-0623", blurb: "Full-grain leather holdall with brass fittings.", tags: ["travel"] },
  { id: 7, name: "Board game: Harbour Lights", price: 34, sku: "KC-GME-0731", blurb: "A family strategy game for 2 to 5 players, ages 10 and up.", tags: ["gift", "teen", "teenager", "family", "present", "birthday"] },
  { id: 8, name: "Linen table runner", price: 45, sku: "KC-LIN-0845", blurb: "Stonewashed linen, 180 cm long.", tags: ["home"] },
];

const defects = new DefectSwitchboard();
const bags = new Map<string, Map<number, number>>();
const orders = new Map<string, { items: [number, number][]; total: number }>();
const subscribers = new Set<string>();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.use((req, res, next) => {
  const m = /(?:^|;\s*)sid=([a-f0-9]+)/.exec(req.headers.cookie ?? "");
  let sid = m?.[1];
  if (!sid) {
    sid = crypto.randomBytes(8).toString("hex");
    res.setHeader("Set-Cookie", `sid=${sid}; Path=/; SameSite=Lax`);
  }
  (req as any).sid = sid;
  next();
});

const bagOf = (sid: string) => bags.get(sid) ?? bags.set(sid, new Map()).get(sid)!;
const bagCount = (sid: string) => [...bagOf(sid).values()].reduce((a, b) => a + b, 0);
const money = (n: number) => `$${n.toFixed(2)}`;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const D = (id: string) => defects.has(id);

const SEARCH_ICON = `<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="2"/><path d="M20 20l-4-4" stroke="currentColor" stroke-width="2"/></svg>`;

function layout(sid: string, title: string, body: string, opts: { home?: boolean } = {}): string {
  const count = bagCount(sid);
  const cookieBanner = D("D01")
    ? `<div id="cookie-banner" class="cookie big" role="region" aria-label="Cookie notice"><p>We use cookies to improve your experience, personalise content and ads, provide social media features and analyse our traffic. By continuing you agree to our use of cookies.</p><div><button class="btn" onclick="acceptCookies()">Accept all</button> <a href="#" onclick="acceptCookies();return false" class="small-link">Manage</a></div></div>`
    : `<div id="cookie-banner" class="cookie slim" role="region" aria-label="Cookie notice"><span>We use cookies.</span> <button class="btn btn-small" onclick="acceptCookies()">OK</button></div>`;
  const newsletter = opts.home
    ? D("D09")
      ? `<div id="nl" class="modal-backdrop" hidden><div class="modal" role="dialog" aria-modal="true" aria-labelledby="nl-title"><span class="close-x" onclick="closeNl()">×</span><h2 id="nl-title">Get 10% off</h2><p>Join our newsletter for a welcome code.</p><input id="nl-email" type="email" placeholder="Email address"><button class="btn" id="nl-go" onclick="subscribe('nl-email')">Subscribe</button></div></div>`
      : `<div id="nl" class="modal-backdrop" hidden><div class="modal" role="dialog" aria-modal="true" aria-labelledby="nl-title"><button class="close-x" aria-label="Close" onclick="closeNl()">×</button><h2 id="nl-title">Get 10% off</h2><p>Join our newsletter for a welcome code.</p><label for="nl-email">Email address</label><input id="nl-email" type="email"><button class="btn" id="nl-go" onclick="subscribe('nl-email')">Subscribe</button></div></div>`
    : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Kindling &amp; Co.</title><style>${CSS}</style></head><body>
<header class="top"><a href="/" class="logo">Kindling &amp; Co.</a>
<form action="/search" class="search" role="search"><input name="q" type="search" placeholder="Search" ${D("D03") ? "" : 'aria-label="Search products"'}><button type="submit" class="icon-btn" ${D("D03") ? "" : 'aria-label="Search"'}>${SEARCH_ICON}</button></form>
<nav><a href="/products">Shop</a> <a href="/bag" id="bag-link">Bag (<span id="bag-count">${count}</span>)</a></nav></header>
<main>${body}</main>
<footer><p>Kindling &amp; Co. · Small things, made well.</p><form onsubmit="subscribe('ft-email');return false"><label for="ft-email">Newsletter</label> <input id="ft-email" type="email" placeholder="you@example.com"> <button class="btn btn-small">Subscribe</button></form><p id="ft-msg" role="status"></p></footer>
${cookieBanner}${newsletter}
<script>${CLIENT_JS(opts.home ?? false)}</script></body></html>`;
}

const CLIENT_JS = (home: boolean) => `
function acceptCookies(){document.cookie='cookies=1;path=/';var b=document.getElementById('cookie-banner');if(b)b.remove();}
if(document.cookie.indexOf('cookies=1')>=0){var cb=document.getElementById('cookie-banner');if(cb)cb.remove();}
function subscribe(id){var v=document.getElementById(id).value;fetch('/api/subscribe',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:v})}).then(function(r){return r.json()}).then(function(j){var m=document.getElementById('ft-msg');if(m)m.textContent=j.ok?"You're subscribed! Your code is WELCOME10.":"Please enter a valid email.";var nl=document.getElementById('nl');if(nl&&j.ok){nl.querySelector('.modal').innerHTML='<h2>Thanks!</h2><p>You\\'re subscribed! Your code is WELCOME10.</p><button class=\\"btn\\" onclick=\\"closeNl()\\">Close</button>';}});}
function closeNl(){var nl=document.getElementById('nl');if(nl){nl.hidden=true;document.cookie='nl=1;path=/';}}
${home && D("D09") ? `
if(document.cookie.indexOf('nl=1')<0){setTimeout(function(){var nl=document.getElementById('nl');nl.hidden=false;var f=nl.querySelectorAll('input,button');f[0]&&f[0].focus();
 nl.addEventListener('keydown',function(e){
  ${D("D09") ? `if(e.key==='Tab'){e.preventDefault();var a=document.getElementById('nl-email'),b=document.getElementById('nl-go');(document.activeElement===a?b:a).focus();}` : `if(e.key==='Escape'){closeNl();}`}
 });},1500);}` : ""}
`;

app.get("/", (req, res) => {
  const sid = (req as any).sid;
  const featured = PRODUCTS.slice(0, 4).map(card).join("");
  res.send(layout(sid, "Home", `<section class="hero"><h1>Thoughtful gifts, made by hand</h1><p>Small-batch goods from independent makers. Free delivery over $50.</p><a class="btn" href="/products">Shop all gifts</a></section><h2>Featured</h2><div class="grid">${featured}</div>`, { home: true }));
});

function card(p: Product): string {
  return `<article class="card"><a href="/products/${p.id}"><div class="ph" aria-hidden="true">${p.name[0]}</div><h3>${esc(p.name)}</h3></a><p class="price">${money(p.price)}</p></article>`;
}

app.get("/products", (req, res) => {
  const sid = (req as any).sid;
  const promo = D("D11")
    ? `<div id="promo-slot"></div><script>setTimeout(function(){document.getElementById('promo-slot').innerHTML='<div class="promo">Autumn sale: 15% off candles this week only</div>'},1200)</script>`
    : `<div class="promo">Autumn sale: 15% off candles this week only</div>`;
  res.send(layout(sid, "Shop", `<h1>All products</h1>${promo}<div class="grid">${PRODUCTS.map(card).join("")}</div>`));
});

app.get("/products/:id", (req, res) => {
  const sid = (req as any).sid;
  const p = PRODUCTS.find((x) => x.id === Number(req.params.id));
  if (!p) return res.status(404).send(layout(sid, "Not found", "<h1>Product not found</h1>"));
  const skuLine = D("D07") ? `<p class="meta">SKU: ${p.sku} · RRP ${money(p.price * 1.2)}</p>` : "";
  const feedback = D("D02")
    ? `fetch('/api/bag',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({productId:${p.id},qty:Number(document.getElementById('qty').value)})});`
    : `fetch('/api/bag',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({productId:${p.id},qty:Number(document.getElementById('qty').value)})}).then(function(r){return r.json()}).then(function(j){document.getElementById('bag-count').textContent=j.count;var t=document.getElementById('toast');t.innerHTML='Added to your bag. <a href="/bag">View bag</a>';t.hidden=false;});`;
  res.send(layout(sid, p.name, `<div class="pdp"><div class="ph big" aria-hidden="true">${p.name[0]}</div><div><h1>${esc(p.name)}</h1><p class="price">${money(p.price)}</p>${skuLine}<p>${esc(p.blurb)}</p>
<label for="qty">Quantity</label> <select id="qty"><option>1</option><option>2</option><option>3</option></select>
<p><button class="btn" id="add" onclick="${esc(feedback)}">Add to bag</button></p><p id="toast" class="toast" role="status" hidden></p>
<p class="${D("D06") ? "faint" : "note"}">Delivery in 3–5 working days. Free over $50.</p></div></div>`));
});

app.get("/search", (req, res) => {
  const sid = (req as any).sid;
  const q = String(req.query.q ?? "").trim().toLowerCase();
  const words = q.split(/\s+/).filter(Boolean);
  const hits = PRODUCTS.filter((p) => words.length && words.every((w) => p.name.toLowerCase().includes(w) || (!D("D08") && p.tags.some((t) => t.startsWith(w.replace(/s$/, ""))))));
  const body = hits.length
    ? `<h1>Results for “${esc(q)}”</h1><div class="grid">${hits.map(card).join("")}</div>`
    : `<h1>Results for “${esc(q)}”</h1><p>No results found. Try a different search.</p>`;
  res.send(layout(sid, "Search", body));
});

app.get("/bag", (req, res) => {
  const sid = (req as any).sid;
  const bag = bagOf(sid);
  const lines = [...bag.entries()].map(([id, qty]) => ({ p: PRODUCTS.find((x) => x.id === id)!, qty }));
  const total = lines.reduce((s, l) => s + l.p.price * l.qty, 0);
  if (!lines.length) return res.send(layout(sid, "Your bag", `<h1>Your bag</h1><p>Your bag is empty.</p><a class="btn" href="/products">Start shopping</a>`));
  const rows = lines.map((l) => `<tr><td>${esc(l.p.name)}${D("D07") ? `<br><small>SKU ${l.p.sku}</small>` : ""}</td><td>${l.qty}</td><td>${money(l.p.price * l.qty)}</td></tr>`).join("");
  const totalLabel = D("D07") ? "Cart subtotal excl. VAT" : "Total";
  const coupon = `<div class="coupon"><label for="coupon">Promo code</label> <input id="coupon"> <button class="btn btn-small btn-ghost" id="apply" ${D("D12") ? "" : `onclick="var v=document.getElementById('coupon').value.trim().toUpperCase();document.getElementById('cmsg').textContent=v==='WELCOME10'?'Code applied: 10% off at checkout.':'That code is not valid.'"`}>Apply</button><p id="cmsg" role="status"></p></div>`;
  const actions = D("D05")
    ? `<div class="${D("D01") ? "sticky-actions" : "actions"}"><a class="btn btn-wide" href="/products">Continue shopping</a> <a class="${D("D06") ? "faint-link" : "link"}" href="/checkout">Checkout</a></div>`
    : `<div class="actions"><a class="btn btn-wide" href="/checkout">Checkout</a> <a class="link" href="/products">Continue shopping</a></div>`;
  res.send(layout(sid, "Your bag", `<h1>Your bag</h1><table class="bag"><thead><tr><th>Item</th><th>Qty</th><th>Price</th></tr></thead><tbody>${rows}</tbody></table>
<p class="total"><strong>${totalLabel}: ${money(total)}</strong></p><p class="${D("D06") ? "faint" : "note"}">Delivery calculated at the next step.</p>${coupon}${actions}`));
});

app.get("/checkout", (req, res) => {
  const sid = (req as any).sid;
  if (!bagCount(sid)) return res.redirect("/bag");
  const mode = String(req.query.mode ?? (D("D10") ? "account" : "guest"));
  const lbl = (id: string, text: string, type = "text", auto = "") =>
    D("D13") && ["address", "city", "zip"].includes(id)
      ? `<input id="${id}" name="${id}" type="${type}" placeholder="${text}" ${auto}>`
      : `<label for="${id}">${text}</label><input id="${id}" name="${id}" type="${type}" ${auto}>`;
  if (mode === "account") {
    return res.send(layout(sid, "Checkout", `<h1>Create an account to continue</h1><p>Members get faster checkout and order tracking.</p>
<form id="acct" onsubmit="event.preventDefault();document.getElementById('amsg').textContent='Please choose a stronger password (12+ characters, a symbol and a number).'">
<label for="a-email">Email</label><input id="a-email" type="email" autocomplete="email"><label for="a-pass">Password</label><input id="a-pass" type="password"><button class="btn">Create account</button><p id="amsg" role="alert"></p></form>
<p class="tiny"><a class="${D("D06") ? "faint-link" : "link"}" href="/checkout?mode=guest">or continue without an account</a></p>`));
  }
  const phoneCheck = D("D04")
    ? `if(!/^\\+1 \\(\\d{3}\\) \\d{3}-\\d{4}$/.test(f.phone.value)){return;}`
    : `if(f.phone.value.replace(/\\D/g,'').length<10){var m=document.getElementById('pmsg');m.textContent='Please enter a 10-digit phone number, e.g. 555 123 4567.';f.phone.setAttribute('aria-invalid','true');return;}`;
  const placing = D("D14") ? "" : `var b=document.getElementById('place');b.disabled=true;b.textContent='Placing order…';`;
  res.send(layout(sid, "Checkout", `<h1>Checkout</h1><form id="co" novalidate onsubmit="event.preventDefault();submitOrder(this)">
${lbl("name", "Full name", "text", 'autocomplete="name"')}${lbl("email", "Email", "email", 'autocomplete="email"')}
<label for="phone">Phone</label><input id="phone" name="phone" type="tel" autocomplete="tel"><p id="pmsg" class="error" role="alert"></p>
${lbl("address", "Street address")}${lbl("city", "City")}${lbl("zip", "ZIP code")}
<p class="note">Payment is taken on delivery (test shop).</p><button class="btn btn-wide" id="place">Place order</button></form>
<script>function submitOrder(f){ ${phoneCheck} ${placing}
fetch('/api/orders',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:f.name.value})}).then(function(r){return r.json()}).then(function(j){location.href='/order/'+j.id;});}</script>`));
});

app.get("/order/:id", (req, res) => {
  const sid = (req as any).sid;
  const o = orders.get(req.params.id);
  if (!o) return res.status(404).send(layout(sid, "Order", "<h1>Order not found</h1>"));
  res.send(layout(sid, "Order confirmed", `<h1>Order confirmed</h1><p>Thank you for your order. Your order number is <strong>${req.params.id}</strong>. Total ${money(o.total)}.</p><a class="btn" href="/">Back to the shop</a>`));
});

app.post("/api/bag", (req, res) => {
  const sid = (req as any).sid;
  const { productId, qty } = req.body ?? {};
  if (!PRODUCTS.some((p) => p.id === Number(productId))) return res.status(400).json({ error: "unknown product" });
  const bag = bagOf(sid);
  bag.set(Number(productId), (bag.get(Number(productId)) ?? 0) + Math.max(1, Number(qty) || 1));
  res.json({ ok: true, count: bagCount(sid) });
});

app.post("/api/orders", async (req, res) => {
  const sid = (req as any).sid;
  const bag = bagOf(sid);
  if (!bag.size) return res.status(400).json({ error: "empty bag" });
  await new Promise((r) => setTimeout(r, D("D14") ? 3500 : 500));
  const id = `KC${Math.floor(100000 + Math.random() * 899999)}`;
  const items = [...bag.entries()];
  orders.set(id, { items, total: items.reduce((s, [pid, q]) => s + PRODUCTS.find((p) => p.id === pid)!.price * q, 0) });
  bags.delete(sid);
  res.status(201).json({ id });
});

app.post("/api/subscribe", (req, res) => {
  const email = String(req.body?.email ?? "");
  const ok = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
  if (ok) subscribers.add(email);
  res.json({ ok });
});

// ---------------------------------------------------------------- admin (benchmark control)
app.get("/__defects", (_req, res) => res.json(defects.list()));
app.post("/__defects", (req, res) => {
  const { id, enabled, all } = req.body ?? {};
  if (all !== undefined) for (const d of DEFECTS) defects.set(d.id, Boolean(all));
  else defects.set(String(id).toUpperCase(), Boolean(enabled));
  res.json(defects.list());
});
app.post("/__reset", (_req, res) => {
  orders.clear();
  res.json({ ok: true });
});

const CSS = `
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
`;

export function startShop(port = Number(process.env.PORT ?? 4400)) {
  return app.listen(port, () => console.log(`Kindling & Co. demo shop on http://localhost:${port}  (defects: ${defects.list().filter((d) => d.enabled).map((d) => d.id).join(",") || "none"})`));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) startShop();
