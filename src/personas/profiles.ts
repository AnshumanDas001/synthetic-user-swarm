// Maps each persona trait to the mechanism that enforces it (spec, Persona engine table):
// browser context, perception filter, action filter, budget, prompt.
import type { ActionProfile, PersonaBudget, PersonaCard, PerceptionProfile } from "../types.js";
import type { BrowserContextOptions } from "playwright";

export function perceptionProfile(card: PersonaCard): PerceptionProfile {
  return {
    // Screen reader: no screenshot at all, only the accessibility tree in reading order.
    screenshot: card.accessibility.screen_reader ? "none" : "full",
    colorVision: card.accessibility.color_vision,
    // Skimmers see headings, buttons and the first ~12 words of each text block.
    skim: card.reading === "skim",
    skimWords: 12,
    zoom: card.accessibility.zoom,
  };
}

export function actionProfile(card: PersonaCard): ActionProfile {
  return {
    keyboardOnly: card.accessibility.keyboard_only || card.accessibility.screen_reader,
    // Real users don't guess URLs; letting the agent do it hides navigation problems.
    allowGoto: false,
    touch: card.device.touch,
  };
}

export function personaBudget(card: PersonaCard, overrides: { maxSteps?: number; wallClockMinutes: number; tokens: number }): PersonaBudget {
  return {
    maxSteps: Math.min(card.patience.max_steps, overrides.maxSteps ?? Infinity),
    maxRetriesPerObstacle: card.patience.max_retries_per_obstacle,
    wallClockMs: overrides.wallClockMinutes * 60_000,
    maxTokens: overrides.tokens,
  };
}

export function isMobile(card: PersonaCard): boolean {
  if (card.device.mobile !== undefined) return card.device.mobile;
  const [w] = card.device.viewport.split("x").map(Number);
  return card.device.touch && w < 900;
}

// Device and network are enforced through the browser context. Zoom is emulated the way a browser
// does it: a smaller CSS viewport rendered at a higher device scale factor.
export function contextOptions(card: PersonaCard, userAgentSuffix: string): BrowserContextOptions {
  const [w, h] = card.device.viewport.split("x").map(Number);
  const zoom = card.accessibility.zoom / 100;
  const mobile = isMobile(card);
  const baseUA = mobile
    ? "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36"
    : "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
  return {
    viewport: { width: Math.round(w / zoom), height: Math.round(h / zoom) },
    deviceScaleFactor: zoom,
    isMobile: mobile,
    hasTouch: card.device.touch,
    locale: card.locale,
    timezoneId: card.timezone ?? "UTC",
    geolocation: card.geolocation,
    permissions: card.geolocation ? ["geolocation"] : [],
    userAgent: `${baseUA} ${userAgentSuffix}`,
    reducedMotion: "reduce",
    colorScheme: "light",
  };
}

// Chromium CDP network conditions per profile (download/upload in bytes/s, latency ms).
export const NETWORK_CONDITIONS: Record<PersonaCard["device"]["network"], { latency: number; download: number; upload: number } | null> = {
  fast: null,
  "4g": { latency: 60, download: (9 * 1024 * 1024) / 8, upload: (3 * 1024 * 1024) / 8 },
  "slow-4g": { latency: 150, download: (1.6 * 1024 * 1024) / 8, upload: (750 * 1024) / 8 },
  "3g": { latency: 300, download: (750 * 1024) / 8, upload: (250 * 1024) / 8 },
};

// Words per minute by reading style and literacy, for the time-on-task estimate.
export function readingWpm(card: PersonaCard): number {
  const base = { skim: 450, normal: 240, thorough: 170 }[card.reading];
  const literacyFactor = 0.6 + 0.1 * card.digital_literacy; // 0.7 .. 1.1
  const languageFactor = card.non_native ? 0.75 : 1;
  return base * literacyFactor * languageFactor;
}
