// Browser sandbox: one fresh, isolated browser context per session (no shared cookies, storage or cache),
// persona device/network emulation, a domain allowlist that acts as the egress proxy, and continuous
// capture of console, network, rrweb and the Playwright trace.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { chromium, type Browser, type BrowserContext, type CDPSession, type Page } from "playwright";
import { config } from "../config.js";
import { contextOptions, NETWORK_CONDITIONS } from "../personas/profiles.js";
import type { PersonaCard } from "../types.js";
import { hostOf, redact } from "../util/common.js";
import { robotsBlocks, type RobotsRules } from "./robots.js";
import { urlIsSafe } from "./netguard.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const SUS_SCRIPT = fs.readFileSync(path.join(here, "injected", "sus.js"), "utf8");
const RRWEB_RECORD = fs.readFileSync(require.resolve("rrweb/dist/record/rrweb-record.min.js"), "utf8");
export const AXE_SOURCE = fs.readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");

// rrweb records the DOM continuously; inputs are masked at capture time (redaction).
const RRWEB_BOOT = `
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
})();`;

export class BrowserPool {
  private browser: Browser | null = null;
  private starting: Promise<Browser> | null = null;

  // Pre-warm so tiles light up the moment a study launches.
  async warm(): Promise<void> {
    await this.get();
  }

  async get(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;
    this.starting ??= chromium.launch({ headless: config.headless, args: ["--disable-dev-shm-usage"] }).then((b) => {
      this.browser = b;
      this.starting = null;
      return b;
    });
    return this.starting;
  }

  async close(): Promise<void> {
    await this.browser?.close().catch(() => {});
    this.browser = null;
  }
}

export interface NetEntry {
  stepId: string | null;
  method: string;
  url: string;
  status: number;
  resourceType: string;
  startedAt: number;
  durationMs: number;
  failed: boolean;
  failure?: string;
}

export interface ConsoleEntry {
  stepId: string | null;
  type: string;
  text: string;
  at: number;
}

export interface Sandbox {
  context: BrowserContext;
  page: Page;
  cdp: CDPSession | null;
  network: NetEntry[];
  console: ConsoleEntry[];
  rrweb: unknown[];
  dialogs: { stepId: string | null; type: string; message: string }[];
  blockedRequests: string[];
  inflight: Map<object, { url: string; method: string; startedAt: number }>;
  currentStepId: string | null;
  tracePath: string;
  close(): Promise<void>;
}

export function domainAllowed(url: string, allowed: string[]): boolean {
  if (url.startsWith("data:") || url.startsWith("blob:") || url.startsWith("about:")) return true;
  const host = hostOf(url);
  return allowed.some((d) => host === d || host.endsWith(`.${d}`));
}

export async function openSandbox(pool: BrowserPool, card: PersonaCard, allowedDomains: string[], robots: RobotsRules | null = null): Promise<Sandbox> {
  const browser = await pool.get();
  const context = await browser.newContext({ ...contextOptions(card, config.userAgentSuffix), recordVideo: undefined });
  const tracePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sus-trace-")), "trace.zip");
  await context.tracing.start({ screenshots: true, snapshots: true });

  const sb: Sandbox = {
    context, page: null as unknown as Page, cdp: null, network: [], console: [], rrweb: [], dialogs: [],
    blockedRequests: [], inflight: new Map(), currentStepId: null, tracePath,
    async close() {
      await context.tracing.stop({ path: tracePath }).catch(() => {});
      await context.close().catch(() => {});
    },
  };

  // Egress allowlist: the agent cannot wander off the study's domains.
  await context.route("**/*", async (route) => {
    const url = route.request().url();
    // Hosted mode: never reach private networks, this server or cloud metadata, whatever the study says.
    if (!(await urlIsSafe(url))) {
      sb.blockedRequests.push(`private: ${url}`);
      return route.abort("blockedbyclient");
    }
    // Page loads into robots.txt-disallowed paths are refused, like requests to other domains.
    if (route.request().isNavigationRequest() && robotsBlocks(robots, url)) {
      sb.blockedRequests.push(`robots: ${url}`);
      return route.abort("blockedbyclient");
    }
    if (domainAllowed(url, allowedDomains)) return route.continue();
    sb.blockedRequests.push(url);
    return route.abort("blockedbyclient");
  });

  await context.exposeBinding("__susEmit", (_src, events: unknown[]) => {
    if (Array.isArray(events)) sb.rrweb.push(...events);
  });
  await context.addInitScript({ content: SUS_SCRIPT });
  await context.addInitScript({ content: `${RRWEB_RECORD}\n${RRWEB_BOOT}` });

  const page = await context.newPage();
  sb.page = page;

  // Network throttling per persona (Chromium CDP).
  const net = NETWORK_CONDITIONS[card.device.network];
  if (net) {
    sb.cdp = await context.newCDPSession(page);
    await sb.cdp.send("Network.enable");
    await sb.cdp.send("Network.emulateNetworkConditions", {
      offline: false, latency: net.latency, downloadThroughput: net.download, uploadThroughput: net.upload,
    });
  }

  const started = new WeakMap<object, number>();
  page.on("request", (req) => {
    started.set(req, Date.now());
    if (!/image|font|media|stylesheet/.test(req.resourceType())) sb.inflight.set(req, { url: req.url(), method: req.method(), startedAt: Date.now() });
  });
  page.on("requestfinished", (req) => sb.inflight.delete(req));
  page.on("requestfailed", (req) => sb.inflight.delete(req));
  page.on("requestfinished", async (req) => {
    const res = await req.response().catch(() => null);
    const t0 = started.get(req) ?? Date.now();
    sb.network.push({
      stepId: sb.currentStepId, method: req.method(), url: req.url(), status: res?.status() ?? 0,
      resourceType: req.resourceType(), startedAt: t0, durationMs: Date.now() - t0, failed: false,
    });
  });
  page.on("requestfailed", (req) => {
    const t0 = started.get(req) ?? Date.now();
    sb.network.push({
      stepId: sb.currentStepId, method: req.method(), url: req.url(), status: 0, resourceType: req.resourceType(),
      startedAt: t0, durationMs: Date.now() - t0, failed: true, failure: req.failure()?.errorText,
    });
  });
  page.on("console", (msg) => {
    if (msg.type() === "error" || msg.type() === "warning") {
      sb.console.push({ stepId: sb.currentStepId, type: msg.type(), text: redact(msg.text()).slice(0, 1000), at: Date.now() });
    }
  });
  page.on("pageerror", (err) => {
    sb.console.push({ stepId: sb.currentStepId, type: "exception", text: redact(String(err.message)).slice(0, 1000), at: Date.now() });
  });
  // Native dialogs (alert/confirm) are recorded and dismissed like a user pressing OK.
  page.on("dialog", async (d) => {
    sb.dialogs.push({ stepId: sb.currentStepId, type: d.type(), message: redact(d.message()) });
    await d.accept().catch(() => {});
  });

  return sb;
}

// Inputs whose contents never appear in stored screenshots.
export function sensitiveLocators(page: Page) {
  return [page.locator('input[type=password], input[autocomplete^="cc-"], input[name*="card" i], input[name*="cvv" i], input[name*="cvc" i]')];
}
