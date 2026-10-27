#!/usr/bin/env node
// swarm CLI: plan, run, resume, analyse, report, diff, ci, bench, serve, personas, export.
import fs from "node:fs";
import YAML from "yaml";
import { config } from "./config.js";
import { createDeps, planStudy, runStudy } from "./orchestrator/orchestrator.js";
import { analyseSession, synthesizeStudy } from "./analysis/pipeline.js";
import { buildReport } from "./report/html.js";
import { diffStudies } from "./report/diff.js";
import { exportIssue } from "./report/integrations.js";
import { scoreBenchmark } from "./report/benchmark.js";
import { startServer } from "./server/server.js";
import { loadCuratedPersonas } from "./personas/library.js";
import { generatePersonas } from "./personas/generator.js";
import { severityLabel } from "./analysis/severity.js";
import { creditsRemaining } from "./llm/client.js";
import { discoverDomains } from "./runtime/domains.js";
import { estimateStudy } from "./llm/estimate.js";
import { StudySpec } from "./types.js";

const HELP = `swarm — Synthetic User Swarm

Usage:
  swarm run <study.yaml> [--no-merge] [--pdf]     plan + run a study, then write the report
  swarm plan <study.yaml>                         expand a study into sessions; prints the study id
  swarm resume <studyId>                          continue a study after a crash (keeps recorded steps)
  swarm analyse <studyId> [--no-merge]            re-run analysis and synthesis on recorded evidence
  swarm report <studyId> [--compare <studyId>] [--pdf]
  swarm diff <baseStudyId> <headStudyId>          label issues new / fixed / regressed / unchanged
  swarm ci <studyId> --baseline <studyId> [--min-severity 3]
                                                  exit 1 when a new issue at or above the severity appears
  swarm bench <studyId> [--defects D04,D14] [--method llm|keyword]
                                                  recall / precision against the demo shop's seeded defects
  swarm export <issueId> --to github|jira|linear [--study <studyId>] [--dry-run]
  swarm personas [--generate "<segment>" --count N]
  swarm studies                                   list studies
  swarm credits                                   OpenRouter credit left on this key
  swarm domains <url>                             hosts a site contacts, for allowed_domains
  swarm estimate <study.yaml>                     expected and worst-case cost before running
  swarm serve [--port 4300]                       live dashboard + API

Environment (.env is loaded): OPENROUTER_API_KEY, SWARM_MODEL_MODE=live|mock (currently: ${config.modelMode}),
SWARM_STEP_MODEL (currently: ${config.models.step}), SWARM_CRITIC_MODEL, SWARM_CREDIT_RESERVE_USD, SWARM_DATA_DIR`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}
const has = (args: string[], name: string) => args.includes(`--${name}`);

function loadSpec(file: string): unknown {
  const text = fs.readFileSync(file, "utf8");
  return file.endsWith(".json") ? JSON.parse(text) : YAML.parse(text);
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd || cmd === "help" || cmd === "--help") return console.log(HELP);

  if (cmd === "serve") {
    const port = Number(flag(args, "port") ?? config.port);
    await startServer(port);
    return;
  }

  const deps = createDeps();
  try {
    switch (cmd) {
      case "plan": {
        const id = await planStudy(deps, loadSpec(args[0]));
        console.log(id);
        break;
      }
      case "run": {
        const id = await planStudy(deps, loadSpec(args[0]));
        console.log(`study ${id}  (model mode: ${config.modelMode})`);
        const ac = new AbortController();
        process.once("SIGINT", () => { console.log("\nstopping after in-flight sessions…"); ac.abort(); });
        await runStudy(deps, id, { llmMerge: !has(args, "no-merge"), signal: ac.signal });
        await printSummary(deps, id);
        const study = deps.db.study(id)!;
        const r = await buildReport(deps, id, { compareTo: study.spec.compare_to, pdf: has(args, "pdf") });
        console.log(`report: ${r.htmlPath}`);
        break;
      }
      case "resume": {
        await runStudy(deps, args[0], { llmMerge: !has(args, "no-merge") });
        await printSummary(deps, args[0]);
        break;
      }
      case "analyse": {
        for (const s of deps.db.sessions(args[0])) {
          if (["succeeded", "gave_up", "failed", "timed_out", "analysed"].includes(s.status)) await analyseSession(deps.db, deps.blobs, s.id);
        }
        await synthesizeStudy(deps.db, args[0], { llmMerge: !has(args, "no-merge") });
        await printSummary(deps, args[0]);
        break;
      }
      case "report": {
        const r = await buildReport(deps, args[0], { compareTo: flag(args, "compare"), pdf: has(args, "pdf") });
        console.log(r.htmlPath);
        if (r.pdfPath) console.log(r.pdfPath);
        break;
      }
      case "diff": {
        const d = diffStudies(deps.db, args[0], args[1]);
        for (const row of d.rows) console.log(`${row.status.padEnd(10)} ${row.severity.toFixed(2)}  ${row.title}`);
        console.log(JSON.stringify(d.counts));
        break;
      }
      case "ci": {
        const baseline = flag(args, "baseline");
        const min = Number(flag(args, "min-severity") ?? 3);
        const issues = deps.db.issues(args[0]);
        const failing = baseline
          ? diffStudies(deps.db, baseline, args[0]).rows.filter((r) => (r.status === "new" || r.status === "regressed") && r.severity >= min)
          : issues.filter((i) => i.severity >= min && i.confidence !== "low").map((i) => ({ status: "open", severity: i.severity, title: i.title }));
        const out = { study: args[0], baseline: baseline ?? null, minSeverity: min, failing };
        console.log(JSON.stringify(out, null, 2));
        process.exitCode = failing.length ? 1 : 0;
        break;
      }
      case "bench": {
        const only = flag(args, "defects");
        const res = await scoreBenchmark(deps.db, args[0], only ? only.split(",") : undefined, (flag(args, "method") as "llm" | "keyword") ?? "auto");
        console.log(JSON.stringify(res, null, 2));
        break;
      }
      case "export": {
        const issueId = args[0];
        const to = flag(args, "to") as "github" | "jira" | "linear";
        const res = await exportIssue(deps, issueId, to, { studyId: flag(args, "study"), dryRun: has(args, "dry-run") });
        console.log(JSON.stringify(res, null, 2));
        break;
      }
      case "personas": {
        const seg = flag(args, "generate");
        if (seg) {
          const { cards } = await generatePersonas(seg, Number(flag(args, "count") ?? 4), 42);
          console.log(YAML.stringify(cards));
        } else {
          for (const p of loadCuratedPersonas()) console.log(`${p.id.padEnd(22)} ${p.device.viewport.padEnd(10)} ${p.archetype}`);
        }
        break;
      }
      case "domains": {
        const list = await discoverDomains(args[0]);
        for (const d of list) console.log(`${String(d.requests).padStart(5)}  ${d.host}`);
        console.log(`\nallowed_domains: [${list.map((d) => d.host).join(", ")}]`);
        console.log("Keep only hosts the tasks need (your app, its API, CDN, auth); drop analytics and ad hosts.");
        break;
      }
      case "credits": {
        const c = await creditsRemaining();
        console.log(c.remainingUsd === null ? `used $${c.usedUsd.toFixed(2)} (no limit on this key)` : `$${c.remainingUsd.toFixed(2)} left of $${c.limitUsd?.toFixed(2)} (used $${c.usedUsd.toFixed(2)}; reserve kept: $${config.creditReserveUsd})`);
        break;
      }
      case "estimate": {
        const spec = StudySpec.parse(loadSpec(args[0]));
        const count = spec.personas.size ?? (spec.personas.include.length || loadCuratedPersonas().length);
        const e = await estimateStudy(spec, count);
        console.log(`${e.sessions} sessions × ~${e.assumedStepsPerSession} steps on ${e.models.step}`);
        console.log(`expected ≈ $${e.totalUsd.toFixed(2)}  (≈ $${e.perSessionUsd.toFixed(4)}/session, $${e.perStepUsd.toFixed(5)}/step)`);
        console.log(`worst case (every session hits max steps) ≈ $${e.worstCaseUsd.toFixed(2)}; study cap $${e.capUsd}`);
        break;
      }
      case "studies": {
        for (const s of deps.db.studies()) console.log(`${s.id}  ${s.status.padEnd(9)} $${s.costUsd.toFixed(2).padStart(6)}  ${new Date(s.createdAt).toISOString().slice(0, 16)}  ${s.name}`);
        break;
      }
      default:
        console.log(HELP);
        process.exitCode = 2;
    }
  } finally {
    await deps.pool.close();
  }
}

async function printSummary(deps: ReturnType<typeof createDeps>, studyId: string) {
  const sessions = deps.db.sessions(studyId);
  const by = (st: string) => sessions.filter((s) => (s.outcome ?? s.status) === st).length;
  const study = deps.db.study(studyId)!;
  console.log(`\n${sessions.length} sessions: ${by("succeeded")} succeeded, ${by("gave_up")} gave up, ${by("failed")} failed, ${by("timed_out")} timed out, ${by("infra_error")} infra errors · cost $${study.costUsd.toFixed(3)}`);
  const issues = deps.db.issues(studyId);
  console.log(`${issues.length} issues:`);
  for (const i of issues.slice(0, 15)) {
    console.log(`  ${i.severity.toFixed(2)} ${severityLabel(i.severity).padEnd(12)} ${i.confidence.padEnd(6)} ${i.title}  [${i.reach.label}]`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});


