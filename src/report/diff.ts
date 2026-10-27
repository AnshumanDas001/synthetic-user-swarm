// Run diff: compare two studies on the same tasks and label each issue new, fixed, regressed or unchanged.
// Issues match on their fingerprint (page + element + heuristic) or, failing that, on text similarity.
import type { Db } from "../store/db.js";
import type { Issue } from "../types.js";
import { cosine, embedText } from "../analysis/embed.js";
import { normalize } from "../analysis/cluster.js";

export type DiffStatus = "new" | "fixed" | "regressed" | "unchanged";

export interface DiffRow {
  status: DiffStatus;
  title: string;
  severity: number;
  baseSeverity: number | null;
  headIssueId: string | null;
  baseIssueId: string | null;
}

export function matchIssues(base: Issue[], head: Issue[]): Map<string, string> {
  const pairs = new Map<string, string>(); // head id -> base id
  const used = new Set<string>();
  for (const h of head) {
    const exact = base.find((b) => !used.has(b.id) && b.fingerprint === h.fingerprint);
    if (exact) {
      pairs.set(h.id, exact.id);
      used.add(exact.id);
    }
  }
  const vec = (i: Issue) => embedText(`${i.title} ${i.description} ${i.page} ${i.element}`);
  for (const h of head) {
    if (pairs.has(h.id)) continue;
    const hv = vec(h);
    let best: { id: string; sim: number } | null = null;
    for (const b of base) {
      if (used.has(b.id)) continue;
      const samePage = normalize(b.page) === normalize(h.page);
      const sim = cosine(hv, vec(b)) + (samePage ? 0.1 : 0);
      if (sim > 0.62 && (!best || sim > best.sim)) best = { id: b.id, sim };
    }
    if (best) {
      pairs.set(h.id, best.id);
      used.add(best.id);
    }
  }
  return pairs;
}

export function diffIssues(base: Issue[], head: Issue[]): { rows: DiffRow[]; counts: Record<DiffStatus, number> } {
  const pairs = matchIssues(base, head);
  const matchedBase = new Set(pairs.values());
  const rows: DiffRow[] = [];
  for (const h of head) {
    const bId = pairs.get(h.id);
    const b = bId ? base.find((x) => x.id === bId)! : null;
    // Regressed: still present and noticeably worse (higher severity or wider reach).
    const status: DiffStatus = !b ? "new" : h.severity >= b.severity + 0.5 || h.reach.sessions >= b.reach.sessions * 1.5 + 1 ? "regressed" : "unchanged";
    rows.push({ status, title: h.title, severity: h.severity, baseSeverity: b?.severity ?? null, headIssueId: h.id, baseIssueId: b?.id ?? null });
  }
  for (const b of base) {
    if (!matchedBase.has(b.id)) rows.push({ status: "fixed", title: b.title, severity: 0, baseSeverity: b.severity, headIssueId: null, baseIssueId: b.id });
  }
  const order: DiffStatus[] = ["regressed", "new", "unchanged", "fixed"];
  rows.sort((a, z) => order.indexOf(a.status) - order.indexOf(z.status) || z.severity - a.severity);
  const counts = { new: 0, fixed: 0, regressed: 0, unchanged: 0 } as Record<DiffStatus, number>;
  for (const r of rows) counts[r.status]++;
  return { rows, counts };
}

export function diffStudies(db: Db, baseStudyId: string, headStudyId: string) {
  return diffIssues(db.issues(baseStudyId), db.issues(headStudyId));
}
