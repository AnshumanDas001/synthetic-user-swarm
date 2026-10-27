// Act stage: one browser action per step, filtered by the persona's action profile.
// Pointer actions land where the element appears on screen, like a real tap: if a cookie banner
// covers the button, the tap hits the banner. That is how covered CTAs become evidence.
import type { Page } from "playwright";
import type { ActionProfile, AgentAction, MarkedElement } from "../types.js";

export interface ActResult {
  error?: string;
  blockedByPolicy?: boolean;
  target?: MarkedElement | null;
  targetCovered?: boolean;
  coveredBy?: string | null;
  scrolledIntoView?: boolean;
  // How far the target moved between perception and the tap (content shifting under the finger).
  targetMoved?: { dx: number; dy: number };
  charsTyped: number;
}

const IRREVERSIBLE = /\b(place (my )?order|pay now|buy now|complete purchase|confirm (and )?pay|submit order|send message|delete account)\b/i;
const POINTER = new Set(["click", "tap", "hover", "select", "scroll"]);

export function allowedActions(p: ActionProfile, screenReader: boolean): string[] {
  if (screenReader) return ["click", "type", "select", "press", "back", "wait", "give_up", "done"];
  if (p.keyboardOnly) return ["press", "type", "back", "wait", "give_up", "done"];
  const base = [p.touch ? "tap" : "click", "type", "select", "scroll", "press", "back", "wait", "give_up", "done"];
  if (!p.touch) base.push("hover");
  if (p.allowGoto) base.push("goto");
  return base;
}

export async function act(
  page: Page,
  action: AgentAction,
  elements: MarkedElement[],
  profile: ActionProfile,
  opts: { screenReader: boolean; allowIrreversible: boolean; focusedMark: string | null },
): Promise<ActResult> {
  const allowed = allowedActions(profile, opts.screenReader);
  const kind = action.type === "tap" && !profile.touch ? "click" : action.type === "click" && profile.touch ? "tap" : action.type;
  if (!allowed.includes(kind) && !(kind === "tap" && allowed.includes("click")) && !(kind === "click" && allowed.includes("tap"))) {
    return { error: `action "${action.type}" is not available to this persona (allowed: ${allowed.join(", ")})`, charsTyped: 0 };
  }
  if (profile.keyboardOnly && !opts.screenReader && POINTER.has(action.type)) {
    return { error: "keyboard-only persona cannot use pointer actions", charsTyped: 0 };
  }

  const byMark = (mark: number) => elements.find((e) => e.mark === mark) ?? null;
  const loc = (mark: number) => page.locator(`[data-sus-mark="${mark}"]`).first();

  switch (action.type) {
    case "click":
    case "tap": {
      const target = byMark(action.mark);
      if (!target) return { error: `no element with mark ${action.mark}`, charsTyped: 0, target: null };
      if (!opts.allowIrreversible && IRREVERSIBLE.test(target.name)) return { blockedByPolicy: true, target, charsTyped: 0 };
      if (opts.screenReader) {
        // Screen-reader activation: move focus to the element and press Enter. A div with an onclick
        // and no keyboard handler does nothing here, exactly as for a real screen-reader user.
        try {
          await loc(action.mark).focus({ timeout: 2000 });
          await page.keyboard.press("Enter");
          return { target, charsTyped: 0 };
        } catch (e) {
          return { error: `could not activate element: ${(e as Error).message.split("\n")[0]}`, target, charsTyped: 0 };
        }
      }
      return pointerActivate(page, action.mark, target, profile.touch);
    }
    case "hover": {
      const target = byMark(action.mark);
      const hit = await page.evaluate(`window.__sus.pointHits(${action.mark})`) as { found: boolean; x: number; y: number };
      if (!target || !hit.found) return { error: `no element with mark ${action.mark}`, charsTyped: 0 };
      await page.mouse.move(hit.x, hit.y, { steps: 4 });
      return { target, charsTyped: 0 };
    }
    case "type": {
      const target = byMark(action.mark);
      if (!target) return { error: `no element with mark ${action.mark}`, charsTyped: 0, target: null };
      if (profile.keyboardOnly && !opts.screenReader && opts.focusedMark !== String(action.mark)) {
        return { error: "keyboard-only persona can only type into the focused field; use Tab to move focus", target, charsTyped: 0 };
      }
      let res: ActResult = { target, charsTyped: 0 };
      if (!profile.keyboardOnly) {
        res = await pointerActivate(page, action.mark, target, profile.touch);
        if (res.error) return res;
      } else if (opts.screenReader) {
        await loc(action.mark).focus({ timeout: 2000 }).catch(() => {});
      }
      await page.evaluate(`window.__sus.markTouched(${action.mark})`);
      // Replace existing content the way a user would: select all, then type.
      await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
      await page.keyboard.type(action.text, { delay: 0 });
      if (action.submit) await page.keyboard.press("Enter");
      return { ...res, charsTyped: action.text.length };
    }
    case "select": {
      const target = byMark(action.mark);
      if (!target) return { error: `no element with mark ${action.mark}`, charsTyped: 0 };
      try {
        await loc(action.mark).selectOption({ label: action.option }, { timeout: 3000 }).catch(() => loc(action.mark).selectOption(action.option, { timeout: 3000 }));
        await page.evaluate(`window.__sus.markTouched(${action.mark})`);
        return { target, charsTyped: 0 };
      } catch (e) {
        return { error: `could not select "${action.option}": ${(e as Error).message.split("\n")[0]}`, target, charsTyped: 0 };
      }
    }
    case "scroll": {
      const vh = (page.viewportSize()?.height ?? 800) * 0.8;
      await page.mouse.wheel(0, action.direction === "down" ? vh : -vh);
      await page.waitForTimeout(300);
      return { charsTyped: 0 };
    }
    case "press": {
      const times = action.times ?? 1;
      for (let i = 0; i < times; i++) await page.keyboard.press(normalizeKey(action.key));
      return { charsTyped: 0 };
    }
    case "back":
      await page.goBack({ timeout: 15_000 }).catch(() => {});
      return { charsTyped: 0 };
    case "wait":
      await page.waitForTimeout(Math.min(10, action.seconds) * 1000);
      return { charsTyped: 0 };
    case "goto":
      await page.goto(action.url, { timeout: 30_000 }).catch((e) => ({ error: String(e) }));
      return { charsTyped: 0 };
    case "give_up":
    case "done":
      return { charsTyped: 0 };
  }
}

async function pointerActivate(page: Page, mark: number, target: MarkedElement, touch: boolean): Promise<ActResult> {
  let hit = await page.evaluate(`window.__sus.pointHits(${mark})`) as { found: boolean; x: number; y: number; inView: boolean; covered: boolean; coveredBy: string | null };
  let scrolled = false;
  if (!hit.found) {
    // Element re-rendered: fall back to its last known coordinates (spec: coordinate fallback).
    const x = target.box.x + target.box.width / 2;
    const y = target.box.y + target.box.height / 2;
    const scroll = await page.evaluate("({x: scrollX, y: scrollY})") as { x: number; y: number };
    hit = { found: true, x: x - scroll.x, y: y - scroll.y, inView: true, covered: false, coveredBy: null };
  } else if (!hit.inView) {
    // A user scrolls the element into view before tapping it.
    await page.locator(`[data-sus-mark="${mark}"]`).first().scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(200);
    hit = await page.evaluate(`window.__sus.pointHits(${mark})`) as typeof hit;
    scrolled = true;
  }
  // A person aims where the element WAS when they looked. If it moved since, they hit whatever is there now.
  let moved: ActResult["targetMoved"];
  if (!scrolled && target.vbox) {
    const dx = Math.round(hit.x - (target.vbox.x + target.vbox.width / 2));
    const dy = Math.round(hit.y - (target.vbox.y + target.vbox.height / 2));
    if (Math.abs(dx) > 24 || Math.abs(dy) > 24) moved = { dx, dy };
  }
  if (moved) {
    const ox = target.vbox!.x + target.vbox!.width / 2;
    const oy = target.vbox!.y + target.vbox!.height / 2;
    if (touch) await page.touchscreen.tap(ox, oy);
    else await page.mouse.click(ox, oy);
  } else if (touch) await page.touchscreen.tap(hit.x, hit.y);
  else await page.mouse.click(hit.x, hit.y);
  return { target, targetCovered: hit.covered, coveredBy: hit.coveredBy, scrolledIntoView: scrolled, targetMoved: moved, charsTyped: 0 };
}

function normalizeKey(k: string): string {
  const map: Record<string, string> = {
    enter: "Enter", return: "Enter", tab: "Tab", "shift+tab": "Shift+Tab", space: "Space", " ": "Space",
    esc: "Escape", escape: "Escape", up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight",
    pagedown: "PageDown", pageup: "PageUp", backspace: "Backspace",
  };
  return map[k.trim().toLowerCase()] ?? k;
}
