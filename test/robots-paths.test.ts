import { describe, expect, it } from "vitest";
import { parseRobots, robotsBlocks } from "../src/runtime/robots.js";
import { pagePath } from "../src/util/common.js";

describe("robots.txt", () => {
  const toolshop = `# Practice Software Testing - Toolshop
User-agent: *
Allow: /
Disallow: /account
Disallow: /admin
Disallow: /auth
Disallow: /checkout

Sitemap: https://practicesoftwaretesting.com/sitemap.xml`;
  const rules = parseRobots(toolshop, "practicesoftwaretesting.com");

  it("reads the disallowed paths for every agent", () => {
    expect(rules.disallow).toEqual(["/account", "/admin", "/auth", "/checkout"]);
  });
  it("blocks disallowed paths on the same host only", () => {
    expect(robotsBlocks(rules, "https://practicesoftwaretesting.com/checkout")).toBe(true);
    expect(robotsBlocks(rules, "https://practicesoftwaretesting.com/auth/login")).toBe(true);
    expect(robotsBlocks(rules, "https://practicesoftwaretesting.com/product/01M5YKQMJ2FCGMPD7B57TC2VF4")).toBe(false);
    expect(robotsBlocks(rules, "https://api.practicesoftwaretesting.com/checkout")).toBe(false);
  });
  it("ignores groups for other agents and lets a longer Allow win", () => {
    const r = parseRobots("User-agent: Googlebot\nDisallow: /\n\nUser-agent: *\nDisallow: /private\nAllow: /private/help", "x.com");
    expect(r.disallow).toEqual([]);
    const r2 = parseRobots("User-agent: *\nDisallow: /private", "x.com");
    expect(robotsBlocks(r2, "https://x.com/private/a")).toBe(true);
  });
});

describe("page paths", () => {
  it("collapses ULIDs, UUIDs and numeric ids so one template is one page", () => {
    expect(pagePath("https://practicesoftwaretesting.com/product/01M5YKQMJ2FCGMPD7B57TC2VF4")).toBe("/product/:id");
    expect(pagePath("https://x.com/orders/3f2a9c1e-5b7d-4e8a-9c21-7d4e5f6a8b90/items/42")).toBe("/orders/:id/items/:id");
    expect(pagePath("https://x.com/category/hand-tools")).toBe("/category/hand-tools");
  });
});

import { stateHash } from "../src/runtime/perception.js";
describe("page state", () => {
  it("treats a scrolled view of the same page as a different screen, but not a 1px nudge", () => {
    const a = stateHash("https://x.com/", [], "t", { y: 0, vh: 800 });
    expect(stateHash("https://x.com/", [], "t", { y: 900, vh: 800 })).not.toBe(a);
    expect(stateHash("https://x.com/", [], "t", { y: 10, vh: 800 })).toBe(a);
  });
});
