import { describe, expect, it } from "vitest";
import { Db } from "../src/store/db.js";
import { StudySpec } from "../src/types.js";

const spec = StudySpec.parse({
  name: "t", target_url: "http://localhost:4400/", allowed_domains: ["localhost"], permission_confirmed: true,
  tasks: [{ id: "a", goal: "g", success: { url_pattern: "/x" } }], personas: { include: [] },
});

describe("one runner per study", () => {
  it("refuses a second runner while the lease is live, and allows takeover once it expires", () => {
    const db = new Db(":memory:");
    db.insertStudy("s1", spec);
    expect(db.acquireStudyLease("s1", "cli", 60_000)).toBe(true);
    expect(db.acquireStudyLease("s1", "server", 60_000)).toBe(false);
    expect(db.acquireStudyLease("s1", "cli", 60_000)).toBe(true); // renewal
    expect(db.acquireStudyLease("s1", "cli", -1)).toBe(true); // force expiry
    expect(db.acquireStudyLease("s1", "server", 60_000)).toBe(true);
    db.releaseStudyLease("s1", "server");
    expect(db.studyLease("s1").runner).toBeNull();
  });

  it("lets exactly one worker claim a queued session", () => {
    const db = new Db(":memory:");
    db.insertStudy("s1", spec);
    db.insertSession({ id: "ses1", studyId: "s1", taskId: "a", personaId: "p", repetition: 0, seed: 1 });
    expect(db.claimSession("ses1")).toBe(true);
    expect(db.claimSession("ses1")).toBe(false);
  });
});
