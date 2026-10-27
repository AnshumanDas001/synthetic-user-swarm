import { describe, expect, it } from "vitest";
import { PersonaCard, StudySpec } from "../src/types.js";
import { dedupePersonas, loadCuratedPersonas, stratifiedSample } from "../src/personas/library.js";
import { actionProfile, contextOptions, isMobile, perceptionProfile } from "../src/personas/profiles.js";
import { allowedActions } from "../src/runtime/actions.js";
import { diffIssues } from "../src/report/diff.js";
import { fingerprint } from "../src/analysis/synthesis.js";
import type { Issue } from "../src/types.js";

describe("persona engine", () => {
  const lib = loadCuratedPersonas();

  it("loads 12 curated cards that pass the schema", () => {
    expect(lib).toHaveLength(12);
    expect(lib.map((p) => p.id)).toContain("asha-68-mobile");
  });

  it("rejects a malformed card", () => {
    expect(PersonaCard.safeParse({ id: "Bad Id", name: "x", archetype: "y", digital_literacy: 9, domain_knowledge: 1 }).success).toBe(false);
  });

  it("enforces traits as mechanisms, not prompt text", () => {
    const sam = lib.find((p) => p.id === "sam-screen-reader")!;
    expect(perceptionProfile(sam).screenshot).toBe("none");
    expect(actionProfile(sam).keyboardOnly).toBe(true);
    const ravi = lib.find((p) => p.id === "ravi-keyboard")!;
    expect(allowedActions(actionProfile(ravi), false)).not.toContain("click");
    const asha = lib.find((p) => p.id === "asha-68-mobile")!;
    expect(perceptionProfile(asha).skim).toBe(true);
    // 150% zoom: a smaller CSS viewport at a higher device scale factor.
    const ctx = contextOptions(asha, "ua");
    expect(ctx.viewport).toEqual({ width: 260, height: 563 });
    expect(ctx.deviceScaleFactor).toBe(1.5);
    expect(ctx.hasTouch).toBe(true);
    expect(isMobile(asha)).toBe(true);
  });

  it("goto is never offered (real users don't guess URLs)", () => {
    for (const p of lib) expect(allowedActions(actionProfile(p), perceptionProfile(p).screenshot === "none")).not.toContain("goto");
  });

  it("stratified sampling honours the mobile share and keeps accessibility edge cases", () => {
    const pick = stratifiedSample(lib, 6, 0.5, 1);
    expect(pick).toHaveLength(6);
    expect(pick.filter(isMobile)).toHaveLength(3);
  });

  it("drops near-duplicate personas", () => {
    const asha = lib[0];
    const twin = { ...asha, id: "asha-twin", name: "Asha 2" };
    expect(dedupePersonas([asha, twin, lib[1]])).toHaveLength(2);
  });
});

describe("study spec", () => {
  const base = {
    name: "t", target_url: "http://localhost:4400/", allowed_domains: ["localhost"], permission_confirmed: true,
    tasks: [{ id: "a", goal: "g", success: { url_pattern: "/x" } }], personas: { include: [] },
  };
  it("requires explicit permission to test the site", () => {
    expect(StudySpec.safeParse({ ...base, permission_confirmed: false }).success).toBe(false);
    expect(StudySpec.safeParse(base).success).toBe(true);
  });
  it("allows 1 to 5 tasks", () => {
    expect(StudySpec.safeParse({ ...base, tasks: [] }).success).toBe(false);
    expect(StudySpec.safeParse({ ...base, tasks: Array(6).fill(base.tasks[0]) }).success).toBe(false);
  });
});

describe("run diff", () => {
  const issue = (id: string, title: string, page: string, element: string, sev: number, sessions = 3): Issue => ({
    id, studyId: "s", taskIds: ["t"], title, description: title, page, element, heuristic: "visibility_of_system_status", impact: "blocked",
    severity: sev, confidence: "high", needsReview: false,
    reach: { sessions, sessionsReachedPage: 6, personas: 2, repetitions: 2, label: "" },
    personaIds: [], candidateIds: [], evidenceStepIds: [], quotes: [], signalTypes: [], status: "open",
    fingerprint: fingerprint(page, element, "visibility_of_system_status"),
  });

  it("labels new, fixed, regressed and unchanged", () => {
    const base = [issue("b1", "Checkout hidden under cookie banner", "/bag", "Checkout", 3), issue("b2", "Add to bag gives no feedback", "/products/:id", "Add to bag", 2), issue("b3", "Coupon does nothing", "/bag", "Apply", 1.2)];
    const head = [issue("h1", "Checkout covered by banner", "/bag", "Checkout", 3), issue("h2", "Add to bag shows nothing", "/products/:id", "Add to bag", 3.2, 6), issue("h3", "Phone field fails silently", "/checkout", "Phone", 3.5)];
    const d = diffIssues(base, head);
    const by = Object.fromEntries(d.rows.map((r) => [r.headIssueId ?? r.baseIssueId, r.status]));
    expect(by.h1).toBe("unchanged");
    expect(by.h2).toBe("regressed");
    expect(by.h3).toBe("new");
    expect(by.b3).toBe("fixed");
    expect(d.counts).toEqual({ new: 1, fixed: 1, regressed: 1, unchanged: 1 });
  });
});
