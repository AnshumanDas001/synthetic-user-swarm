"""Domain discovery for a new target: load the start page (and optionally a few same-site links) and list every
host it contacts, so allowed_domains can include the CDNs, fonts and APIs the site needs."""
from __future__ import annotations

from playwright.async_api import async_playwright

from ..util import host_of
from .netguard import url_is_safe


async def discover_domains(url: str, follow_links: int = 3) -> list[dict]:
    hosts: dict[str, int] = {}
    async with async_playwright() as pw:
        browser = await pw.chromium.launch()
        try:
            page = await browser.new_page()

            async def route(r):
                return await (r.continue_() if await url_is_safe(r.request.url) else r.abort("blockedbyclient"))

            await page.route("**/*", route)

            def on_request(r):
                h = host_of(r.url)
                if h:
                    hosts[h] = hosts.get(h, 0) + 1

            page.on("request", on_request)
            try:
                await page.goto(url, wait_until="networkidle", timeout=45_000)
            except Exception:
                await page.wait_for_timeout(3000)
            home = host_of(url)
            links = await page.eval_on_selector_all("a[href]", "as => as.map(a => a.href)")
            for link in [h for h in links if host_of(h) == home and "#" not in h][:follow_links]:
                try:
                    await page.goto(link, wait_until="networkidle", timeout=30_000)
                except Exception:
                    pass
        finally:
            await browser.close()
    return [{"host": h, "requests": n} for h, n in sorted(hosts.items(), key=lambda kv: -kv[1])]
