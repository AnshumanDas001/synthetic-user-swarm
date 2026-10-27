"""robots.txt support: the swarm stays out of paths a site asks automated agents to avoid."""
from __future__ import annotations

import re
from typing import Optional
from urllib.parse import urljoin, urlsplit

import httpx

from ..util import host_of


def parse_robots(text: str, host: str, agent: str = "syntheticuserswarm") -> dict:
    """Rules for "User-agent: *" (and any group naming the swarm). Allow lines override shorter disallows."""
    disallow: list[str] = []
    allow: list[str] = []
    applies = False
    in_header = False
    for raw in re.split(r"\r?\n", text):
        line = re.sub(r"#.*$", "", raw).strip()
        if not line:
            continue
        k, _, value = line.partition(":")
        key, value = k.strip().lower(), value.strip()
        if key == "user-agent":
            ua = value.lower()
            # Consecutive user-agent lines form one group.
            applies = (in_header and applies) or ua == "*" or agent in ua
            in_header = True
            continue
        in_header = False
        if not applies:
            continue
        if key == "disallow" and value:
            disallow.append(value)
        if key == "allow" and value:
            allow.append(value)
    return {"host": host, "disallow": [d for d in disallow if not any(len(a) >= len(d) and a.startswith(d) for a in allow)]}


async def fetch_robots(origin: str) -> Optional[dict]:
    try:
        async with httpx.AsyncClient(timeout=10, follow_redirects=True) as c:
            res = await c.get(urljoin(origin, "/robots.txt"))
        if res.status_code >= 400:
            return None
        return parse_robots(res.text, host_of(origin))
    except httpx.HTTPError:
        return None


def robots_blocks(rules: Optional[dict], url: str) -> bool:
    if not rules or host_of(url) != rules["host"]:
        return False
    try:
        u = urlsplit(url)
        path = (u.path or "/") + (f"?{u.query}" if u.query else "")
    except ValueError:
        path = "/"
    return any(path == d[:-1] if d.endswith("$") else path.startswith(re.sub(r"\*.*$", "", d)) for d in rules["disallow"])
