// robots.txt support: the swarm stays out of paths a site asks automated agents to avoid.
import { hostOf } from "../util/common.js";

export interface RobotsRules {
  host: string;
  disallow: string[];
}

// Rules for "User-agent: *" (and any group naming the swarm). Allow lines override shorter disallows.
export function parseRobots(text: string, host: string, agent = "syntheticuserswarm"): RobotsRules {
  const disallow: string[] = [];
  const allow: string[] = [];
  let applies = false;
  let inGroupHeader = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const [k, ...rest] = line.split(":");
    const key = k.trim().toLowerCase();
    const value = rest.join(":").trim();
    if (key === "user-agent") {
      const ua = value.toLowerCase();
      // Consecutive user-agent lines form one group.
      applies = (inGroupHeader && applies) || ua === "*" || ua.includes(agent);
      inGroupHeader = true;
      continue;
    }
    inGroupHeader = false;
    if (!applies) continue;
    if (key === "disallow" && value) disallow.push(value);
    if (key === "allow" && value) allow.push(value);
  }
  return { host, disallow: disallow.filter((d) => !allow.some((a) => a.length >= d.length && a.startsWith(d))) };
}

export async function fetchRobots(origin: string): Promise<RobotsRules | null> {
  try {
    const res = await fetch(new URL("/robots.txt", origin), { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    return parseRobots(await res.text(), hostOf(origin));
  } catch {
    return null;
  }
}

export function robotsBlocks(rules: RobotsRules | null | undefined, url: string): boolean {
  if (!rules || hostOf(url) !== rules.host) return false;
  let path = "/";
  try {
    const u = new URL(url);
    path = u.pathname + u.search;
  } catch {}
  return rules.disallow.some((d) => (d.endsWith("$") ? path === d.slice(0, -1) : path.startsWith(d.replace(/\*.*$/, ""))));
}
