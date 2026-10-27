"""SSRF guard for hosted (multi-user) mode: user-supplied studies must not reach this server, its private network,
cloud metadata (169.254.169.254) or local files. Hostnames are resolved and every address checked, at plan time
and again for each browser request (so DNS rebinding cannot slip past a one-time check)."""
from __future__ import annotations

import asyncio
import ipaddress
import socket
import time
from urllib.parse import urlsplit

from ..config import config, multi_user


def is_private_address(ip: str) -> bool:
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return True  # not an IP at all: treat as unsafe
    if isinstance(addr, ipaddress.IPv6Address):
        if addr.ipv4_mapped:
            return is_private_address(str(addr.ipv4_mapped))
        x = addr.exploded.lower()
        return addr in (ipaddress.IPv6Address("::"), ipaddress.IPv6Address("::1")) or x.startswith(("fc", "fd", "fe8", "fe9", "fea", "feb", "ff"))
    a, b = addr.packed[0], addr.packed[1]
    return (a in (0, 10, 127) or (a == 100 and 64 <= b <= 127) or (a == 169 and b == 254) or (a == 172 and 16 <= b <= 31)
            or (a == 192 and b == 168) or (a == 192 and b == 0) or (a == 198 and b in (18, 19)) or a >= 224)


def _allowed_private(host: str, port: str) -> bool:
    allowed = list(config.private_hosts_allowed)
    if config.demo_shop:
        allowed += [f"localhost:{config.demo_shop_port}", f"127.0.0.1:{config.demo_shop_port}"]
    return any(h == host or h == f"{host}:{port}" for h in allowed)


_cache: dict[str, tuple[bool, float]] = {}


async def url_is_safe(raw: str) -> bool:
    """True when the browser (or the server) may fetch this URL."""
    if not multi_user():
        return True
    try:
        u = urlsplit(raw)
        port_num = u.port
    except ValueError:
        return False
    if u.scheme in ("data", "blob", "about"):
        return True
    if u.scheme not in ("http", "https") or not u.hostname:
        return False
    host = u.hostname.lower()
    port = str(port_num or (443 if u.scheme == "https" else 80))
    if _allowed_private(host, port):
        return True
    key = f"{host}:{port}"
    hit = _cache.get(key)
    if hit and time.time() - hit[1] < 60:
        return hit[0]
    try:
        try:
            ipaddress.ip_address(host)
            addrs = [host]
        except ValueError:
            infos = await asyncio.get_running_loop().getaddrinfo(host, None, type=socket.SOCK_STREAM)
            addrs = [i[4][0] for i in infos]
        ok = bool(addrs) and all(not is_private_address(a.split("%")[0]) for a in addrs)
    except OSError:
        ok = False
    _cache[key] = (ok, time.time())
    return ok


async def assert_url_safe(raw: str, what: str) -> None:
    if not await url_is_safe(raw):
        raise ValueError(f"{what} must be a public http(s) address ({raw} is not allowed here)")
