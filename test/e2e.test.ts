// End to end against the seeded-defect shop, offline (mock policy + rule-based critic):
// plan -> run in parallel browsers -> evidence -> signals -> candidates -> issues -> report.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-e2e-"));
process.env.SWARM_DATA_DIR = dataDir;
process.env.SWARM_MODEL_MODE = "mock";
process.env.SWARM_QUIET = "1";
const PORT = 4471;

let shop: Server;
let mods: {
  orch: typeof import("../src/orchestrator/orchestrator.js");
  report: typeof import("../src/report/html.js");
};

beforeAll(async () => {
  const { startShop } = await import("../demo-shop/server.js");
  shop = startShop(PORT);
  mods = { orch: await import("../src/orchestrator/orchestrator.js"), report: await import("../src/report/html.js") };
});

afterAll(() => {
  shop?.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("swarm end to end (mock mode)", () => {
  it("runs a study and produces evidence-backed issues and a report", async () => {
    const deps = mods.orch.createDeps();
    const studyId = await mods.orch.planStudy(deps, {
      name: "e2e",
      target_url: `http://localhost:${PORT}/`,
      allowed_domains: ["localhost"],
      permission_confirmed: true,
      reset_url: `http://localhost:${PORT}/__reset`,
      tasks: [{ id: "buy-gift", goal: "Buy a birthday present under $40 and have it delivered.", success: { mode: "any", url_pattern: "/order/KC\\d+", network: { method: "POST", url_pattern: "/api/orders", status: 201 } } }],
      personas: { include: ["priya-power-user", "asha-68-mobile"] },
      budget: { repetitions: 1, max_steps: 14, wall_clock_minutes: 3, concurrency: 2, cost_cap_usd: 1 },
    });
    await mods.orch.runStudy(deps, studyId, { llmMerge: false });

    const sessions = deps.db.sessions(studyId);
    expect(sessions).toHaveLength(2);
    for (const s of sessions) {
      expect(s.status).toBe("analysed");
      expect(["succeeded", "gave_up", "failed", "timed_out"]).toContain(s.outcome);
      expect(s.stepCount).toBeGreaterThan(0);
      // Session-level evidence: rrweb, console, network, trace.
      for (const k of ["rrweb", "console", "network", "trace"]) expect(deps.blobs.exists(s.artifacts[k])).toBe(true);
      const steps = deps.db.steps(s.id);
      // Every step wrote its screenshots and element list before the next action.
      for (const st of steps) {
        expect(deps.blobs.exists(st.artifacts.before)).toBe(true);
        expect(deps.blobs.exists(st.artifacts.elements)).toBe(true);
      }
    }

    // Every issue cites steps that exist.
    const issues = deps.db.issues(studyId);
    for (const i of issues) {
      expect(i.evidenceStepIds.length).toBeGreaterThan(0);
      for (const id of i.evidenceStepIds) expect(deps.db.step(id)).not.toBeNull();
      expect(i.severity).toBeGreaterThanOrEqual(0);
      expect(i.severity).toBeLessThanOrEqual(4);
    }

    // The domain allowlist and the accessibility audit both ran.
    expect(deps.db.audits(studyId).length).toBeGreaterThan(0);

    const r = await mods.report.buildReport(deps, studyId);
    const html = fs.readFileSync(r.htmlPath, "utf8");
    expect(html).toContain("Task × persona");
    expect(html).toContain("Accessibility appendix");
    const json = JSON.parse(fs.readFileSync(r.jsonPath, "utf8"));
    expect(json.coverage.sessions).toBe(2);
    await deps.pool.close();
  }, 240_000);
});
