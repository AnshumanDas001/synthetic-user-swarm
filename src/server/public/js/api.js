// Thin JSON API client.
async function req(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `${res.status} ${res.statusText}`);
  return json;
}

export const api = {
  get: (url) => req("GET", url),
  post: (url, body = {}) => req("POST", url, body),
  studies: () => req("GET", "/api/studies"),
  study: (id) => req("GET", `/api/studies/${id}`),
  reportData: (id) => req("GET", `/api/studies/${id}/report-data`),
  steps: (id, sid) => req("GET", `/api/studies/${id}/sessions/${sid}/steps`),
  signals: (id, sid) => req("GET", `/api/studies/${id}/sessions/${sid}/signals`),
  step: (id, stepId) => req("GET", `/api/studies/${id}/steps/${stepId}`),
  personas: () => req("GET", "/api/personas"),
  credits: () => req("GET", "/api/credits"),
  me: () => req("GET", "/api/me"),
  saveKey: (key) => req("POST", "/api/account/key", { key }),
  removeKey: () => req("DELETE", "/api/account/key"),
  config: () => req("GET", "/api/config"),
  estimate: (spec) => req("POST", "/api/estimate", spec),
  domains: (url) => req("POST", "/api/domains", { url }),
  launch: (spec) => req("POST", "/api/studies", spec),
  stop: (id) => req("POST", `/api/studies/${id}/stop`),
  resume: (id) => req("POST", `/api/studies/${id}/resume`),
  buildReport: (id) => req("POST", `/api/studies/${id}/report`, {}),
  exportIssue: (issueId, to, studyId, dryRun) => req("POST", `/api/issues/${issueId}/export`, { to, studyId, dryRun }),
};
