// Report data model: everything the HTML report and the JSON export show, computed from the evidence store.
// The JSON is what CI consumes; the HTML renders the same object.
import type { Db, SessionRow } from "../store/db.js";
import type { Issue, PersonaCard, StepRecord, TaskSpec } from "../types.js";
import { median, pagePath } from "../util/common.js";
import { diffIssues, type DiffRow } from "./diff.js";
import { config } from "../config.js";

export interface MatrixCell {
  taskId: string;
  personaId: string;
  sessions: number;
  succeeded: number;
  successRate: number | null;
  medianSteps: number;
  medianHumanSec: number;
}

export interface FunnelStage {
  page: string;
  reached: number;
}

export interface ReportData {
  generatedAt: string;
  study: { id: string; name: string; targetUrl: string; buildId: string | null; status: string; costUsd: number; createdAt: number };
  models: typeof config.models;
  modelMode: string;
  coverage: { sessions: number; analysable: number; infraErrors: number; personas: number; tasks: number; repetitions: number; steps: number; tokens: number };
  tasks: { id: string; goal: string; successRate: number | null; sessions: number; medianHumanSec: number }[];
  personas: PersonaCard[];
  matrix: MatrixCell[];
  funnels: { taskId: string; total: number; stages: FunnelStage[] }[];
  issues: Issue[];
  accessibility: { page: string; violations: { id: string; impact: string | null; help: string; helpUrl: string; nodes: number; sessions: number }[] }[];
  assistiveTech: { personaId: string; name: string; outcome: string; detail: string | null }[];
  sessions: (SessionRow & { personaName: string })[];
  stepsById: Record<string, StepRecord>;
  diff: { comparedTo: string; rows: DiffRow[]; counts: Record<string, number> } | null;
}

export function buildReportData(db: Db, studyId: string, compareTo?: string): ReportData {
  const study = db.study(studyId);
  if (!study) throw new Error(`no study ${studyId}`);
  const tasks = db.tasks(studyId);
  const personas = db.personas(studyId);
  const sessions = db.sessions(studyId);
  const issues = db.issues(studyId);
  const outcome = (s: SessionRow) => s.outcome ?? s.status;
  const analysable = sessions.filter((s) => outcome(s) !== "infra_error" && !["queued", "provisioning", "running"].includes(s.status));
  const steps = new Map<string, StepRecord[]>(sessions.map((s) => [s.id, db.steps(s.id)]));

  const matrix: MatrixCell[] = [];
  for (const t of tasks) {
    for (const p of personas) {
      const ss = analysable.filter((s) => s.taskId === t.id && s.personaId === p.id);
      const ok = ss.filter((s) => outcome(s) === "succeeded");
      matrix.push({
        taskId: t.id, personaId: p.id, sessions: ss.length, succeeded: ok.length,
        successRate: ss.length ? ok.length / ss.length : null,
        medianSteps: median(ss.map((s) => s.stepCount)),
        medianHumanSec: Math.round(median(ss.map((s) => s.estHumanMs)) / 1000),
      });
    }
  }

  const taskSummaries = tasks.map((t) => {
    const ss = analysable.filter((s) => s.taskId === t.id);
    const ok = ss.filter((s) => outcome(s) === "succeeded");
    return { id: t.id, goal: t.goal, sessions: ss.length, successRate: ss.length ? ok.length / ss.length : null, medianHumanSec: Math.round(median(ok.map((s) => s.estHumanMs)) / 1000) };
  });

  const funnels = tasks.map((t) => funnelFor(t, analysable.filter((s) => s.taskId === t.id), steps));

  // Accessibility appendix: axe-core violations by page, counted once per page across sessions.
  const audits = db.audits(studyId);
  const byPage = new Map<string, Map<string, { id: string; impact: string | null; help: string; helpUrl: string; nodes: number; sessions: Set<string> }>>();
  for (const a of audits) {
    const m = byPage.get(a.pagePath) ?? byPage.set(a.pagePath, new Map()).get(a.pagePath)!;
    for (const v of a.violations) {
      const e = m.get(v.id) ?? m.set(v.id, { id: v.id, impact: v.impact, help: v.help, helpUrl: v.helpUrl, nodes: 0, sessions: new Set() }).get(v.id)!;
      e.nodes = Math.max(e.nodes, v.nodes.length);
      e.sessions.add(a.sessionId);
    }
  }
  const impactRank = (i: string | null) => ["critical", "serious", "moderate", "minor"].indexOf(i ?? "minor");
  const accessibility = [...byPage.entries()].map(([page, m]) => ({
    page,
    violations: [...m.values()].map((v) => ({ ...v, sessions: v.sessions.size })).sort((a, b) => impactRank(a.impact) - impactRank(b.impact)),
  })).sort((a, b) => a.page.localeCompare(b.page));

  const at = personas.filter((p) => p.accessibility.screen_reader || p.accessibility.keyboard_only);
  const assistiveTech = analysable.filter((s) => at.some((p) => p.id === s.personaId)).map((s) => ({
    personaId: s.personaId, name: personas.find((p) => p.id === s.personaId)!.name, outcome: outcome(s), detail: s.outcomeDetail,
  }));

  // Only the steps the report cites (issue evidence + quotes) are embedded.
  const cited = new Set(issues.flatMap((i) => [...i.evidenceStepIds, ...i.quotes.map((q) => q.stepId)]));
  const stepsById: Record<string, StepRecord> = {};
  for (const ss of steps.values()) for (const st of ss) if (cited.has(st.id)) stepsById[st.id] = st;

  let diff: ReportData["diff"] = null;
  const baseId = compareTo ?? study.spec.compare_to;
  if (baseId && db.study(baseId)) {
    const d = diffIssues(db.issues(baseId), issues);
    diff = { comparedTo: baseId, rows: d.rows, counts: d.counts };
  }

  return {
    generatedAt: new Date().toISOString(),
    study: { id: study.id, name: study.name, targetUrl: study.targetUrl, buildId: study.buildId, status: study.status, costUsd: study.costUsd, createdAt: study.createdAt },
    models: config.models,
    modelMode: config.modelMode,
    coverage: {
      sessions: sessions.length,
      analysable: analysable.length,
      infraErrors: sessions.filter((s) => outcome(s) === "infra_error").length,
      personas: personas.length,
      tasks: tasks.length,
      repetitions: study.spec.budget.repetitions,
      steps: [...steps.values()].reduce((a, s) => a + s.length, 0),
      tokens: sessions.reduce((a, s) => a + s.tokens, 0),
    },
    tasks: taskSummaries,
    personas,
    matrix,
    funnels,
    issues,
    accessibility,
    assistiveTech,
    sessions: sessions.map((s) => ({ ...s, personaName: personas.find((p) => p.id === s.personaId)?.name ?? s.personaId })),
    stepsById,
    diff,
  };
}

// Drop-off per task: pages ordered by when sessions first reach them; a stage counts sessions that got
// at least that far. Successful sessions define the path; the funnel shows where everyone else leaked.
function funnelFor(task: TaskSpec, sessions: SessionRow[], steps: Map<string, StepRecord[]>): { taskId: string; total: number; stages: FunnelStage[] } {
  const firstSeen = new Map<string, number[]>();
  const paths = sessions.map((s) => {
    const seq: string[] = [];
    for (const st of steps.get(s.id) ?? []) if (!seq.includes(st.pagePath)) seq.push(st.pagePath);
    const last = (steps.get(s.id) ?? []).at(-1)?.observation.urlAfter;
    if (last) {
      const p = pagePath(last);
      if (!seq.includes(p)) seq.push(p);
    }
    return { s, seq };
  });
  const succeeded = paths.filter((p) => (p.s.outcome ?? p.s.status) === "succeeded");
  const basis = succeeded.length ? succeeded : paths;
  for (const { seq } of basis) seq.forEach((page, i) => firstSeen.set(page, [...(firstSeen.get(page) ?? []), i]));
  const minShare = Math.max(1, Math.ceil(basis.length * 0.5));
  const order = [...firstSeen.entries()]
    .filter(([, idx]) => idx.length >= minShare)
    .map(([page, idx]) => ({ page, at: idx.reduce((a, b) => a + b, 0) / idx.length }))
    .sort((a, b) => a.at - b.at)
    .map((x) => x.page);
  const stages = order.map((page, i) => ({
    page,
    reached: paths.filter(({ seq }) => order.slice(i).some((p) => seq.includes(p))).length,
  }));
  return { taskId: task.id, total: sessions.length, stages };
}
