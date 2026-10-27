// One-click export of an issue to GitHub, Jira or Linear, with evidence links attached.
// Tokens come from the environment; without one (or with --dry-run) the payload is returned, not sent.
import type { SwarmDeps } from "../orchestrator/orchestrator.js";
import type { Issue } from "../types.js";
import { config } from "../config.js";
import { severityLabel } from "../analysis/severity.js";

function findIssue(deps: SwarmDeps, issueId: string, studyId?: string): { issue: Issue; studyId: string } {
  const studies = studyId ? [studyId] : deps.db.studies().map((s) => s.id);
  for (const id of studies) {
    const issue = deps.db.issues(id).find((i) => i.id === issueId);
    if (issue) return { issue, studyId: id };
  }
  throw new Error(`issue ${issueId} not found`);
}

export function issueMarkdown(issue: Issue, studyId: string, baseUrl = process.env.SWARM_PUBLIC_URL ?? `http://localhost:${config.port}`): string {
  const replay = issue.evidenceStepIds[0] ? `${baseUrl}/replay/${studyId}/step/${issue.evidenceStepIds[0]}` : null;
  return [
    `**Severity:** ${issue.severity.toFixed(2)} (${severityLabel(issue.severity)}) · **Confidence:** ${issue.confidence}${issue.needsReview ? " (needs human review)" : ""} · **Reach:** ${issue.reach.label}`,
    `**Where:** \`${issue.page}\` — ${issue.element}`,
    `**Heuristic:** ${issue.heuristic.replace(/_/g, " ")}`,
    "",
    issue.description,
    "",
    ...issue.quotes.map((q) => `> "${q.text}" — synthetic user, step \`${q.stepId}\``),
    "",
    `**Signals:** ${issue.signalTypes.join(", ") || "none"}`,
    replay ? `**Watch it happen:** ${replay}` : "",
    ...issue.evidenceStepIds.map((id) => `- Evidence step: ${baseUrl}/api/studies/${studyId}/steps/${id}`),
    "",
    issue.suggestedFix ? `_Suggested fix (a suggestion, not a verdict):_ ${issue.suggestedFix}` : "",
    "",
    `<sub>Found by Synthetic User Swarm, study \`${studyId}\`, issue \`${issue.id}\`.</sub>`,
  ].filter((l) => l !== null).join("\n");
}

export async function exportIssue(deps: SwarmDeps, issueId: string, to: "github" | "jira" | "linear", opts: { studyId?: string; dryRun?: boolean }) {
  const { issue, studyId } = findIssue(deps, issueId, opts.studyId);
  const title = `[UX] ${issue.title}`;
  const body = issueMarkdown(issue, studyId);

  if (to === "github") {
    const repo = process.env.GITHUB_REPO;
    const token = process.env.GITHUB_TOKEN;
    const payload = { title, body, labels: ["usability", `severity:${severityLabel(issue.severity)}`] };
    if (opts.dryRun || !repo || !token) return { sent: false, reason: opts.dryRun ? "dry run" : "GITHUB_REPO / GITHUB_TOKEN not set", payload };
    const res = await fetch(`https://api.github.com/repos/${repo}/issues`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const json = (await res.json()) as { html_url?: string; message?: string };
    return { sent: res.ok, url: json.html_url, error: res.ok ? undefined : json.message };
  }

  if (to === "linear") {
    const key = process.env.LINEAR_API_KEY;
    const teamId = process.env.LINEAR_TEAM_ID;
    const payload = {
      query: "mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { url } } }",
      variables: { input: { teamId, title, description: body, priority: issue.severity >= 3 ? 1 : issue.severity >= 2 ? 2 : 3 } },
    };
    if (opts.dryRun || !key || !teamId) return { sent: false, reason: opts.dryRun ? "dry run" : "LINEAR_API_KEY / LINEAR_TEAM_ID not set", payload };
    const res = await fetch("https://api.linear.app/graphql", { method: "POST", headers: { authorization: key, "content-type": "application/json" }, body: JSON.stringify(payload) });
    const json = (await res.json()) as { data?: { issueCreate?: { issue?: { url: string } } }; errors?: unknown };
    return { sent: res.ok && !json.errors, url: json.data?.issueCreate?.issue?.url, error: json.errors };
  }

  // Jira Cloud REST v2 accepts a plain-text description.
  const base = process.env.JIRA_BASE_URL;
  const email = process.env.JIRA_EMAIL;
  const token = process.env.JIRA_API_TOKEN;
  const project = process.env.JIRA_PROJECT_KEY;
  const payload = { fields: { project: { key: project }, summary: title, description: body, issuetype: { name: "Bug" }, labels: ["usability"] } };
  if (opts.dryRun || !base || !email || !token || !project) return { sent: false, reason: opts.dryRun ? "dry run" : "JIRA_BASE_URL / JIRA_EMAIL / JIRA_API_TOKEN / JIRA_PROJECT_KEY not set", payload };
  const res = await fetch(`${base.replace(/\/$/, "")}/rest/api/2/issue`, {
    method: "POST",
    headers: { authorization: `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const json = (await res.json()) as { key?: string; errors?: unknown };
  return { sent: res.ok, url: json.key ? `${base}/browse/${json.key}` : undefined, error: res.ok ? undefined : json.errors };
}
