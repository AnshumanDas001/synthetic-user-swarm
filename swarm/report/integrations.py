"""One-click export of an issue to GitHub, Jira or Linear, with evidence links attached. Tokens come from the
environment; without one (or with dry_run) the payload is returned, not sent."""
from __future__ import annotations

import base64
import os
from typing import Optional

import httpx

from ..analysis.severity import severity_label
from ..config import config


def find_issue(db, issue_id: str, study_id: Optional[str] = None) -> tuple[dict, str]:
    for sid in [study_id] if study_id else [s["id"] for s in db.studies()]:
        issue = next((i for i in db.issues(sid) if i["id"] == issue_id), None)
        if issue:
            return issue, sid
    raise ValueError(f"issue {issue_id} not found")


def issue_markdown(issue: dict, study_id: str, base_url: Optional[str] = None) -> str:
    base_url = base_url or os.environ.get("SWARM_PUBLIC_URL") or config.public_url or f"http://localhost:{config.port}"
    ev = issue["evidenceStepIds"]
    replay = f"{base_url}/replay/{study_id}/step/{ev[0]}" if ev else None
    lines = [
        f"**Severity:** {issue['severity']:.2f} ({severity_label(issue['severity'])}) · **Confidence:** {issue['confidence']}"
        f"{' (needs human review)' if issue['needsReview'] else ''} · **Reach:** {issue['reach']['label']}",
        f"**Where:** `{issue['page']}` — {issue['element']}",
        f"**Heuristic:** {issue['heuristic'].replace('_', ' ')}",
        "",
        issue["description"],
        "",
        *[f'> "{q["text"]}" — synthetic user, step `{q["stepId"]}`' for q in issue["quotes"]],
        "",
        f"**Signals:** {', '.join(issue['signalTypes']) or 'none'}",
        f"**Watch it happen:** {replay}" if replay else "",
        *[f"- Evidence step: {base_url}/api/studies/{study_id}/steps/{sid}" for sid in ev],
        "",
        f"_Suggested fix (a suggestion, not a verdict):_ {issue['suggestedFix']}" if issue.get("suggestedFix") else "",
        "",
        f"<sub>Found by Synthetic User Swarm, study `{study_id}`, issue `{issue['id']}`.</sub>",
    ]
    return "\n".join(lines)


async def export_issue(db, issue_id: str, to: str, study_id: Optional[str] = None, dry_run: bool = False) -> dict:
    issue, sid = find_issue(db, issue_id, study_id)
    title = f"[UX] {issue['title']}"
    body = issue_markdown(issue, sid)
    env = os.environ
    async with httpx.AsyncClient(timeout=30) as http:
        if to == "github":
            repo, token = env.get("GITHUB_REPO"), env.get("GITHUB_TOKEN")
            payload = {"title": title, "body": body, "labels": ["usability", f"severity:{severity_label(issue['severity'])}"]}
            if dry_run or not repo or not token:
                return {"sent": False, "reason": "dry run" if dry_run else "GITHUB_REPO / GITHUB_TOKEN not set", "payload": payload}
            res = await http.post(f"https://api.github.com/repos/{repo}/issues", json=payload,
                                  headers={"authorization": f"Bearer {token}", "accept": "application/vnd.github+json"})
            j = res.json()
            return {"sent": res.is_success, "url": j.get("html_url"), "error": None if res.is_success else j.get("message")}
        if to == "linear":
            key, team = env.get("LINEAR_API_KEY"), env.get("LINEAR_TEAM_ID")
            prio = 1 if issue["severity"] >= 3 else 2 if issue["severity"] >= 2 else 3
            payload = {"query": "mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { url } } }",
                       "variables": {"input": {"teamId": team, "title": title, "description": body, "priority": prio}}}
            if dry_run or not key or not team:
                return {"sent": False, "reason": "dry run" if dry_run else "LINEAR_API_KEY / LINEAR_TEAM_ID not set", "payload": payload}
            res = await http.post("https://api.linear.app/graphql", json=payload, headers={"authorization": key})
            j = res.json()
            return {"sent": res.is_success and not j.get("errors"), "url": ((j.get("data") or {}).get("issueCreate") or {}).get("issue", {}).get("url"), "error": j.get("errors")}
        # Jira Cloud REST v2 accepts a plain-text description.
        base, email, token, project = env.get("JIRA_BASE_URL"), env.get("JIRA_EMAIL"), env.get("JIRA_API_TOKEN"), env.get("JIRA_PROJECT_KEY")
        payload = {"fields": {"project": {"key": project}, "summary": title, "description": body, "issuetype": {"name": "Bug"}, "labels": ["usability"]}}
        if dry_run or not (base and email and token and project):
            return {"sent": False, "reason": "dry run" if dry_run else "JIRA_BASE_URL / JIRA_EMAIL / JIRA_API_TOKEN / JIRA_PROJECT_KEY not set", "payload": payload}
        auth = base64.b64encode(f"{email}:{token}".encode()).decode()
        res = await http.post(f"{base.rstrip('/')}/rest/api/2/issue", json=payload, headers={"authorization": f"Basic {auth}"})
        j = res.json()
        return {"sent": res.is_success, "url": f"{base}/browse/{j['key']}" if j.get("key") else None, "error": None if res.is_success else j.get("errors")}
