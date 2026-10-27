// Perceive stage: what the agent sees each step, after the persona's perception filter.
// Screenshot with Set-of-Marks + compact element list + URL/title/page-changed + (screen reader) a11y tree.
import type { CDPSession, Page } from "playwright";
import { config } from "../config.js";
import type { MarkedElement, PerceptionProfile } from "../types.js";
import { sensitiveLocators } from "./sandbox.js";
import { sha256 } from "../util/common.js";

export interface PageView {
  url: string;
  title: string;
  elements: MarkedElement[];
  blocks: { tag: string; text: string }[];
  wordsSeen: number;
  validation: string[];
  dialogOpen: boolean;
  searchZeroResults: boolean;
  scroll: { y: number; max: number; vh: number; vw: number };
  focused: string | null;
  textHash: string;
  stateHash: string;
  ariaSnapshot?: string;
  // Evidence (always the real page) and what the model is shown (after filters).
  shotClean?: Buffer;
  shotMarked?: Buffer;
  shotModel?: Buffer;
}

export async function collect(page: Page, profile: PerceptionProfile): Promise<Omit<PageView, "stateHash" | "shotClean" | "shotMarked" | "shotModel">> {
  const raw = await page.evaluate(`window.__sus ? window.__sus.collect(${JSON.stringify({ skim: profile.skim, skimWords: profile.skimWords })}) : null`);
  if (!raw) throw new Error("perception helpers missing on page");
  return raw as Omit<PageView, "stateHash">;
}

// Page-state hash: URL path + the set of controls and their names. Used for loop and backtrack detection.
// "What is on screen": the page, its controls, its text and (coarsely) how far down it is scrolled.
// Scrolling a long page is progress; seeing the same screen three times is a loop.
export function stateHash(url: string, elements: MarkedElement[], textHash: string, scroll?: { y: number; vh: number }): string {
  let pathOnly = url;
  try {
    const u = new URL(url);
    pathOnly = u.pathname + u.search;
  } catch {}
  const sig = elements.map((e) => `${e.role}:${e.name}:${e.state.filter((s) => s !== "focused").join("|")}`).join(";");
  // Keyboard focus is part of the state: for a keyboard user, moving focus is moving.
  const focus = elements.find((e) => e.state.includes("focused"));
  const band = scroll && scroll.vh > 0 ? Math.floor(scroll.y / (scroll.vh / 2)) : 0;
  return sha256(`${pathOnly}#${sig}#${textHash}#${focus ? `${focus.selector}:${focus.name}` : ""}#${band}`).slice(0, 16);
}

export async function perceive(page: Page, profile: PerceptionProfile): Promise<PageView> {
  await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => {});
  // Let pending renders settle briefly; not a network-idle wait (some sites never go idle).
  await page.waitForTimeout(250);
  const base = await collect(page, profile);
  const view: PageView = { ...base, stateHash: stateHash(base.url, base.elements, base.textHash, base.scroll) };

  const mask = sensitiveLocators(page);
  const shot = () => page.screenshot({ type: "jpeg", quality: 70, scale: "css", mask, animations: "disabled", timeout: 15_000 });

  view.shotClean = await shot();
  await page.evaluate("window.__sus.drawMarks()");
  view.shotMarked = await shot();

  if (profile.screenshot === "none") {
    // Screen reader: no screenshot at all, only the accessibility tree in reading order.
    view.shotModel = undefined;
    view.ariaSnapshot = await page.locator("body").ariaSnapshot({ timeout: 10_000 }).catch(() => "");
  } else if (profile.colorVision !== "normal" || profile.skim) {
    await page.evaluate(`window.__sus.setVision(${JSON.stringify(profile.colorVision)}); window.__sus.setSkim(${profile.skim})`);
    view.shotModel = await modelShot(page, view.scroll.vw, view.scroll.vh) ?? await shot();
    await page.evaluate(`window.__sus.setVision("normal"); window.__sus.setSkim(false)`);
  } else {
    view.shotModel = (await modelShot(page, view.scroll.vw, view.scroll.vh)) ?? view.shotMarked;
  }
  await page.evaluate("window.__sus.clearMarks()");
  return view;
}

// What the model sees, downscaled so wide desktop viewports cost fewer image tokens (Chromium CDP
// capture with a scale factor). Returns null when no downscaling is needed or CDP is unavailable.
const cdpSessions = new WeakMap<Page, CDPSession>();
async function modelShot(page: Page, vw: number, vh: number): Promise<Buffer | null> {
  const scale = config.modelImageMaxWidth / vw;
  if (scale >= 1) return null;
  try {
    let cdp = cdpSessions.get(page);
    if (!cdp) {
      cdp = await page.context().newCDPSession(page);
      cdpSessions.set(page, cdp);
    }
    // Clip coordinates are page coordinates, so offset by the current scroll position.
    const { x, y } = (await page.evaluate("({ x: scrollX, y: scrollY })")) as { x: number; y: number };
    const { data } = await cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 65, clip: { x, y, width: vw, height: vh, scale } });
    return Buffer.from(data, "base64");
  } catch {
    return null;
  }
}

// Compact text the model reads next to the screenshot.
export function describeView(view: PageView, opts: { screenReader: boolean; keyboardOnly: boolean; changed: boolean }): string {
  const lines: string[] = [];
  lines.push(`URL: ${view.url}`);
  lines.push(`Title: ${view.title}`);
  lines.push(`Page changed since your last action: ${opts.changed ? "yes" : "no"}`);
  if (view.dialogOpen) lines.push("A dialog or pop-up is open.");
  if (view.validation.length) lines.push(`Messages on screen: ${view.validation.map((v) => `"${v}"`).join("; ")}`);
  lines.push(`Scroll: ${view.scroll.y}px of ${view.scroll.max}px`);
  if (opts.keyboardOnly) lines.push(`Keyboard focus is on: ${view.focused ? `[${view.focused}]` : "nothing (page body)"}`);

  if (opts.screenReader) {
    lines.push("", "Screen reader output (accessibility tree, reading order):", (view.ariaSnapshot ?? "").slice(0, 6000));
    lines.push("", "Elements you can jump to with the screen reader's elements list:");
  } else {
    lines.push("", "Interactive elements (mark, role, name, state, in view):");
  }
  for (const e of view.elements) {
    const name = e.name ? `"${e.name.slice(0, 70)}"` : opts.screenReader ? "(unlabeled)" : "(no accessible name)";
    const flags = [...e.state, e.inView ? "" : "off-screen", e.covered && e.inView ? "partly covered" : ""].filter(Boolean).join(", ");
    lines.push(`[${e.mark}] ${e.role} ${name}${flags ? ` (${flags})` : ""}`);
  }
  if (!opts.screenReader && view.blocks.length) {
    lines.push("", "Text you can see:");
    for (const b of view.blocks.slice(0, 40)) lines.push(`${/^h\d$/.test(b.tag) ? "# " : "- "}${b.text}`);
  }
  return lines.join("\n");
}
