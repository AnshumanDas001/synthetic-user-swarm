"""Accounts: users, free-run usage, encrypted API keys and the platform's daily free-run spend. Kept separate from
the evidence store so it can live in a durable Postgres (DATABASE_URL) while studies sit on an ephemeral disk
(e.g. Render's free tier). Falls back to SQLite next to the evidence store."""
from __future__ import annotations

import asyncio
import re
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from ..config import config
from ..util import new_id, now_ms

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, sub TEXT UNIQUE NOT NULL, email TEXT NOT NULL, name TEXT, picture TEXT, role TEXT NOT NULL DEFAULT 'user',
  free_runs_used INTEGER NOT NULL DEFAULT 0, api_key_enc TEXT, api_key_last4 TEXT, created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS platform_spend (day TEXT PRIMARY KEY, usd DOUBLE PRECISION NOT NULL DEFAULT 0);"""


def today() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def role_for(email: str) -> str:
    return "admin" if email.lower() in config.admin_emails else "user"


def to_user(r: Any) -> dict:
    """User: id, sub (Google subject id), email, name, picture, role, freeRunsUsed, apiKeyEnc, apiKeyLast4, createdAt."""
    r = dict(r)
    return {"id": str(r["id"]), "sub": str(r["sub"]), "email": str(r["email"]), "name": r.get("name") or "", "picture": r.get("picture"),
            "role": r.get("role") or "user", "freeRunsUsed": int(r.get("free_runs_used") or 0), "apiKeyEnc": r.get("api_key_enc"),
            "apiKeyLast4": r.get("api_key_last4"), "createdAt": int(r.get("created_at") or 0)}


class _Sqlite:
    def __init__(self, file: Optional[str] = None):
        path = file or str(config.data_dir / "accounts.db")
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self.db.row_factory = sqlite3.Row
        self.lock = threading.Lock()

    def q(self, sql: str, args: tuple = (), one: bool = False):
        with self.lock:
            cur = self.db.execute(sql.replace("%s", "?"), args)
            if one:
                return cur.fetchone()
            return cur.rowcount

    def init(self):
        with self.lock:
            self.db.executescript(SCHEMA.replace("DOUBLE PRECISION", "REAL"))

    def close(self):
        self.db.close()


class _Pg:
    def __init__(self, url: str):
        import psycopg
        from psycopg.rows import dict_row
        self._connect = lambda: psycopg.connect(url, autocommit=True, row_factory=dict_row,
                                                **({} if re.search(r"localhost|127\.0\.0\.1", url) or "sslmode=" in url else {"sslmode": "require"}))
        self.conn = None
        self.lock = threading.Lock()

    def q(self, sql: str, args: tuple = (), one: bool = False):
        with self.lock:
            for attempt in range(2):
                try:
                    if self.conn is None or self.conn.closed:
                        self.conn = self._connect()
                    cur = self.conn.execute(sql, args)
                    return cur.fetchone() if one else cur.rowcount
                except Exception:
                    # Serverless Postgres (Neon) drops idle connections: reconnect once.
                    self.conn = None
                    if attempt:
                        raise

    def init(self):
        for stmt in SCHEMA.split(";"):
            if stmt.strip():
                self.q(stmt)

    def close(self):
        if self.conn:
            self.conn.close()


class AccountStore:
    """Async facade; the drivers are synchronous and run in a worker thread."""

    def __init__(self, backend):
        self.b = backend
        self.pg = isinstance(backend, _Pg)

    async def _run(self, fn, *args):
        return await asyncio.to_thread(fn, *args)

    async def init(self) -> None:
        await self._run(self.b.init)

    async def upsert_google_user(self, sub: str, email: str, name: str, picture: Optional[str]) -> dict:
        def go():
            self.b.q("INSERT INTO users (id, sub, email, name, picture, role, created_at) VALUES (%s, %s, %s, %s, %s, %s, %s) "
                     "ON CONFLICT (sub) DO UPDATE SET email = excluded.email, name = excluded.name, picture = excluded.picture, role = excluded.role",
                     (new_id("usr"), sub, email, name, picture, role_for(email), now_ms()))
            return to_user(self.b.q("SELECT * FROM users WHERE sub = %s", (sub,), one=True))
        return await self._run(go)

    async def get_user(self, id: str) -> Optional[dict]:
        r = await self._run(lambda: self.b.q("SELECT * FROM users WHERE id = %s", (id,), one=True))
        return to_user(r) if r else None

    async def consume_free_run(self, user_id: str, limit: int) -> bool:
        """Atomically take one free run; False when the user has none left."""
        n = await self._run(lambda: self.b.q("UPDATE users SET free_runs_used = free_runs_used + 1 WHERE id = %s AND free_runs_used < %s", (user_id, limit)))
        return n == 1

    async def refund_free_run(self, user_id: str) -> None:
        fn = "GREATEST" if self.pg else "MAX"
        await self._run(lambda: self.b.q(f"UPDATE users SET free_runs_used = {fn}(0, free_runs_used - 1) WHERE id = %s", (user_id,)))

    async def set_api_key(self, user_id: str, enc: Optional[str], last4: Optional[str]) -> None:
        await self._run(lambda: self.b.q("UPDATE users SET api_key_enc = %s, api_key_last4 = %s WHERE id = %s", (enc, last4, user_id)))

    async def add_platform_spend(self, day: str, usd: float) -> None:
        await self._run(lambda: self.b.q("INSERT INTO platform_spend (day, usd) VALUES (%s, %s) ON CONFLICT (day) DO UPDATE SET usd = platform_spend.usd + excluded.usd", (day, usd)))

    async def platform_spend(self, day: str) -> float:
        r = await self._run(lambda: self.b.q("SELECT usd FROM platform_spend WHERE day = %s", (day,), one=True))
        return float(r["usd"]) if r else 0.0

    async def close(self) -> None:
        await self._run(self.b.close)


def create_account_store(file: Optional[str] = None) -> AccountStore:
    return AccountStore(_Pg(config.database_url) if config.database_url else _Sqlite(file))
