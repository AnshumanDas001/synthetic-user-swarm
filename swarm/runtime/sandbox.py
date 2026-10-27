"""Browser sandbox: one fresh, isolated browser context per session (no shared cookies, storage or cache), persona
device/network emulation, a domain allowlist that acts as the egress proxy, and continuous capture of console,
network, rrweb and the Playwright trace."""
from __future__ import annotations

import asyncio
import re
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

from playwright.async_api import Browser, BrowserContext, Page, Playwright, async_playwright

from ..config import config
from ..models import PersonaCard
from ..personas.profiles import NETWORK_CONDITIONS, context_options
from ..util import host_of, now_ms, redact
from .netguard import url_is_safe
from .robots import robots_blocks

HERE = Path(__file__).resolve().parent
VENDOR = HERE.parent / "vendor"
SUS_SCRIPT = (HERE / "injected" / "sus.js").read_text()
RRWEB_RECORD = (VENDOR / "rrweb-record.min.js").read_text()
AXE_SOURCE = (VENDOR / "axe.min.js").read_text()

# rrweb records the DOM continuously; inputs are masked at capture time (redaction).
RRWEB_BOOT = """
(() => {
  if (window.__susRR || window.top !== window) return;
  window.__susRR = true;
  const buf = [];
  const flush = () => { if (buf.length && window.__susEmit) { window.__susEmit(buf.splice(0)); } };
  rrwebRecord({ emit: (e) => { buf.push(e); if (buf.length > 50) flush(); }, maskAllInputs: true,
    maskInputOptions: { password: true, email: true, tel: true }, sampling: { mousemove: 100, scroll: 150 },
    // Drop scripts, preload links and head noise: smaller recordings, and replays never fetch the site's code.
    slimDOMOptions: { script: true, comment: true, headFavicon: true, headWhitespace: true, headMetaSocial: true, headMetaRobots: true, headMetaHttpEquiv: true, headMetaVerification: true } });
  setInterval(flush, 400);
  addEventListener("pagehide", flush);
})();"""


class BrowserPool:
    """One Chromium per process; every session gets its own context."""

    def __init__(self) -> None:
        self._pw: Optional[Playwright] = None
        self._browser: Optional[Browser] = None
        self._lock = asyncio.Lock()

    async def warm(self) -> None:
        """Pre-warm so tiles light up the moment a study launches."""
        await self.get()

    async def get(self) -> Browser:
        async with self._lock:
            if self._browser and self._browser.is_connected():
                return self._browser
            if self._pw is None:
                self._pw = await async_playwright().start()
            self._browser = await self._pw.chromium.launch(headless=config.headless, args=["--disable-dev-shm-usage"])
            return self._browser

    async def close(self) -> None:
        if self._browser:
            try:
                await self._browser.close()
            except Exception:
                pass
        self._browser = None
        if self._pw:
            await self._pw.stop()
            self._pw = None


@dataclass
class Sandbox:
    context: BrowserContext
    page: Page
    trace_path: str
    cdp: Any = None
    network: list[dict] = field(default_factory=list)
    console: list[dict] = field(default_factory=list)
    rrweb: list = field(default_factory=list)
    dialogs: list[dict] = field(default_factory=list)
    blocked_requests: list[str] = field(default_factory=list)
    inflight: dict = field(default_factory=dict)
    current_step_id: Optional[str] = None

    async def close(self) -> None:
        try:
            await self.context.tracing.stop(path=self.trace_path)
        except Exception:
            pass
        try:
            await self.context.close()
        except Exception:
            pass


def domain_allowed(url: str, allowed: list[str]) -> bool:
    if url.startswith(("data:", "blob:", "about:")):
        return True
    host = host_of(url)
    return any(host == d or host.endswith(f".{d}") for d in allowed)


async def open_sandbox(pool: BrowserPool, card: PersonaCard, allowed_domains: list[str], robots: Optional[dict] = None) -> Sandbox:
    browser = await pool.get()
    context = await browser.new_context(**context_options(card, config.user_agent_suffix))
    trace_path = str(Path(tempfile.mkdtemp(prefix="sus-trace-")) / "trace.zip")
    await context.tracing.start(screenshots=True, snapshots=True)
    sb = Sandbox(context=context, page=None, trace_path=trace_path)  # type: ignore[arg-type]

    # Egress allowlist: the agent cannot wander off the study's domains.
    async def route(r):
        url = r.request.url
        # Hosted mode: never reach private networks, this server or cloud metadata, whatever the study says.
        if not await url_is_safe(url):
            sb.blocked_requests.append(f"private: {url}")
            return await r.abort("blockedbyclient")
        # Page loads into robots.txt-disallowed paths are refused, like requests to other domains.
        if r.request.is_navigation_request() and robots_blocks(robots, url):
            sb.blocked_requests.append(f"robots: {url}")
            return await r.abort("blockedbyclient")
        if domain_allowed(url, allowed_domains):
            return await r.continue_()
        sb.blocked_requests.append(url)
        return await r.abort("blockedbyclient")

    await context.route("**/*", route)

    def emit(_src, events):
        if isinstance(events, list):
            sb.rrweb.extend(events)

    await context.expose_binding("__susEmit", emit)
    await context.add_init_script(script=SUS_SCRIPT)
    await context.add_init_script(script=f"{RRWEB_RECORD}\n{RRWEB_BOOT}")

    page = await context.new_page()
    sb.page = page

    # Network throttling per persona (Chromium CDP).
    net = NETWORK_CONDITIONS[card.device.network]
    if net:
        sb.cdp = await context.new_cdp_session(page)
        await sb.cdp.send("Network.enable")
        await sb.cdp.send("Network.emulateNetworkConditions", {
            "offline": False, "latency": net["latency"], "downloadThroughput": net["download"], "uploadThroughput": net["upload"]})

    started: dict = {}
    noise = re.compile(r"image|font|media|stylesheet")

    def on_request(req):
        started[req] = now_ms()
        if not noise.search(req.resource_type):
            sb.inflight[req] = {"url": req.url, "method": req.method, "startedAt": now_ms()}

    async def on_finished(req):
        sb.inflight.pop(req, None)
        try:
            res = await req.response()
        except Exception:
            res = None
        t0 = started.pop(req, now_ms())
        sb.network.append({"stepId": sb.current_step_id, "method": req.method, "url": req.url, "status": res.status if res else 0,
                           "resourceType": req.resource_type, "startedAt": t0, "durationMs": now_ms() - t0, "failed": False})

    def on_failed(req):
        sb.inflight.pop(req, None)
        t0 = started.pop(req, now_ms())
        sb.network.append({"stepId": sb.current_step_id, "method": req.method, "url": req.url, "status": 0, "resourceType": req.resource_type,
                           "startedAt": t0, "durationMs": now_ms() - t0, "failed": True, "failure": req.failure})

    def on_console(msg):
        if msg.type in ("error", "warning"):
            sb.console.append({"stepId": sb.current_step_id, "type": msg.type, "text": redact(msg.text)[:1000], "at": now_ms()})

    def on_pageerror(err):
        sb.console.append({"stepId": sb.current_step_id, "type": "exception", "text": redact(str(err))[:1000], "at": now_ms()})

    # Native dialogs (alert/confirm) are recorded and dismissed like a user pressing OK.
    async def on_dialog(d):
        sb.dialogs.append({"stepId": sb.current_step_id, "type": d.type, "message": redact(d.message)})
        try:
            await d.accept()
        except Exception:
            pass

    page.on("request", on_request)
    page.on("requestfinished", on_finished)
    page.on("requestfailed", on_failed)
    page.on("console", on_console)
    page.on("pageerror", on_pageerror)
    page.on("dialog", on_dialog)
    return sb


def sensitive_locators(page: Page) -> list:
    """Inputs whose contents never appear in stored screenshots."""
    return [page.locator('input[type=password], input[autocomplete^="cc-"], input[name*="card" i], input[name*="cvv" i], input[name*="cvc" i]')]
