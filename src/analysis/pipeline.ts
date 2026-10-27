// Analysis in three passes: deterministic signals -> LLM critic per session -> cross-session synthesis.
import type { Db } from "../store/db.js";
import type { BlobStore } from "../store/blobs.js";
import type { EventBus } from "../store/events.js";
import { detectSignals } from "./signals.js";
import { critiqueSession } from "./critic.js";
import { synthesize } from "./synthesis.js";
import type { Issue, SignalRecord, StepRecord } from "../types.js";
import { log } from "../util/common.js";

export async function analyseSession(db: Db, blobs: BlobStore, sessionId: string): Promise<{ accepted: number; rejected: number; costUsd: number }> {
  const s = db.session(sessionId);
  if (!s) throw new Error(`no session ${sessionId}`);
  const steps = db.steps(sessionId);
  const outcome = { status: s.outcome ?? s.status, detail: s.outcomeDetail };

  // Pass 1
  const signals = detectSignals(steps, outcome);
  db.replaceSignals(sessionId, signals);

  // Infra errors never count as usability findings.
  if (outcome.status === "infra_error") {
    db.replaceCandidates(sessionId, s.studyId, []);
    return { accepted: 0, rejected: 0, costUsd: 0 };
  }

  // Pass 2
  const card = db.personas(s.studyId).find((p) => p.id === s.personaId)!;
  const task = db.tasks(s.studyId).find((t) => t.id === s.taskId)!;
  const study = db.study(s.studyId)!;
  const useLlm = study.costUsd < study.spec.budget.cost_cap_usd;
  const res = await critiqueSession({ sessionId, studyId: s.studyId, repetition: s.repetition, card, task, outcome, steps, signals, useLlm }, blobs);
  db.replaceCandidates(sessionId, s.studyId, res.accepted);
  if (res.rejected.length) log("critic", `${sessionId}: rejected ${res.rejected.length} candidate(s) without evidence: ${res.rejected.map((r) => r.reasons[0]).join(" | ")}`);
  const costUsd = res.usage?.costUsd ?? 0;
  if (costUsd) db.addStudyCost(s.studyId, costUsd);
  db.updateSession(sessionId, { status: "analysed" });
  return { accepted: res.accepted.length, rejected: res.rejected.length, costUsd };
}

export async function synthesizeStudy(db: Db, studyId: string, opts: { llmMerge: boolean; bus?: EventBus }): Promise<Issue[]> {
  const sessions = db.sessions(studyId);
  const stepsBySession = new Map<string, StepRecord[]>();
  const signalsBySession = new Map<string, SignalRecord[]>();
  for (const s of sessions) {
    stepsBySession.set(s.id, db.steps(s.id));
    signalsBySession.set(s.id, db.signals(s.id));
  }
  const { issues, usage } = await synthesize({
    studyId,
    candidates: db.candidates(studyId),
    sessions,
    stepsBySession,
    signalsBySession,
    personas: db.personas(studyId),
    useLlmMerge: opts.llmMerge,
  });
  if (usage) db.addStudyCost(studyId, usage.costUsd);
  db.replaceIssues(studyId, issues);
  opts.bus?.publish(studyId, "issues.updated", { issues: issues.map(issueSummary) });
  return issues;
}

export function issueSummary(i: Issue) {
  return { id: i.id, title: i.title, page: i.page, severity: i.severity, confidence: i.confidence, reach: i.reach.label, sessions: i.reach.sessions, personas: i.personaIds };
}
