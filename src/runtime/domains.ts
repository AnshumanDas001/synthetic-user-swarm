// Domain discovery for a new target: load the start page (and optionally a few same-site links) and list
// every host it contacts, so allowed_domains can include the CDNs, fonts and APIs the site needs.
import { chromium } from "playwright";
import { hostOf } from "../util/common.js";
import { urlIsSafe } from "./netguard.js";

export async function discoverDomains(url: string, opts: { followLinks?: number } = {}) {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.route("**/*", async (route) => ((await urlIsSafe(route.request().url())) ? route.continue() : route.abort("blockedbyclient")));
  const hosts = new Map<string, number>();
  page.on("request", (r) => {
    const h = hostOf(r.url());
    if (h) hosts.set(h, (hosts.get(h) ?? 0) + 1);
  });
  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: 45_000 }).catch(() => page.waitForTimeout(3000));
    const home = hostOf(url);
    const links = (await page.$$eval("a[href]", (as) => as.map((a) => (a as HTMLAnchorElement).href)))
      .filter((h) => hostOf(h) === home && !h.includes("#"))
      .slice(0, opts.followLinks ?? 3);
    for (const l of links) await page.goto(l, { waitUntil: "networkidle", timeout: 30_000 }).catch(() => {});
  } finally {
    await browser.close();
  }
  return [...hosts.entries()].sort((a, b) => b[1] - a[1]).map(([host, requests]) => ({ host, requests }));
}
