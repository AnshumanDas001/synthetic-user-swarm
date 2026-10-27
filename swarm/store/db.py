"""Evidence store metadata: the spec's nine entities in SQLite. Blobs live in the content-addressed BlobStore;
rows only hold their keys. Records come back as camelCase dicts, exactly as the dashboard consumes them."""
from __future__ import annotations

import json
import sqlite3
import threading
from pathlib import Path
from typing import Any, Optional

from ..config import config
from ..models import PersonaCard, StudySpec, TaskSpec
from ..util import now_ms

SCHEMA = """
CREATE TABLE IF NOT EXISTS study (
  id TEXT PRIMARY KEY, name TEXT, target_url TEXT, allowed_domains TEXT, persona_mix TEXT,
  budget TEXT, spec TEXT, status TEXT, build_id TEXT, cost_usd REAL DEFAULT 0,
  created_at INTEGER, finished_at INTEGER, runner TEXT, lease_until INTEGER DEFAULT 0,
  owner_id TEXT, key_source TEXT DEFAULT 'platform'
);
CREATE TABLE IF NOT EXISTS task (
  id TEXT, study_id TEXT, goal_text TEXT, start_url TEXT, success_criteria TEXT, PRIMARY KEY (study_id, id)
);
CREATE TABLE IF NOT EXISTS persona (
  id TEXT, study_id TEXT, card TEXT, perception_profile TEXT, action_profile TEXT, budget TEXT, PRIMARY KEY (study_id, id)
);
CREATE TABLE IF NOT EXISTS session (
  id TEXT PRIMARY KEY, study_id TEXT, task_id TEXT, persona_id TEXT, repetition INTEGER, seed INTEGER,
  status TEXT, outcome TEXT, outcome_detail TEXT, step_count INTEGER DEFAULT 0, cost REAL DEFAULT 0,
  tokens INTEGER DEFAULT 0, est_human_ms INTEGER DEFAULT 0, attempts INTEGER DEFAULT 0,
  artifacts TEXT DEFAULT '{}', started_at INTEGER, ended_at INTEGER
);
CREATE INDEX IF NOT EXISTS session_study ON session(study_id);
CREATE TABLE IF NOT EXISTS step (
  id TEXT PRIMARY KEY, session_id TEXT, idx INTEGER, url TEXT, page_path TEXT, title TEXT, state_hash TEXT,
  action TEXT, think_aloud TEXT, expectation TEXT, confidence INTEGER, frustration INTEGER,
  target TEXT, observation TEXT, artifacts TEXT, tokens_in INTEGER, tokens_out INTEGER, cost REAL,
  model TEXT, est_human_ms INTEGER, started_at INTEGER, ended_at INTEGER
);
CREATE INDEX IF NOT EXISTS step_session ON step(session_id, idx);
CREATE TABLE IF NOT EXISTS signal (id TEXT PRIMARY KEY, step_id TEXT, session_id TEXT, type TEXT, details TEXT);
CREATE INDEX IF NOT EXISTS signal_session ON signal(session_id);
CREATE TABLE IF NOT EXISTS candidate_issue (id TEXT PRIMARY KEY, session_id TEXT, study_id TEXT, data TEXT, embedding TEXT);
CREATE TABLE IF NOT EXISTS issue (id TEXT PRIMARY KEY, study_id TEXT, severity REAL, data TEXT);
CREATE TABLE IF NOT EXISTS report (
  id TEXT PRIMARY KEY, study_id TEXT, version INTEGER, compared_to_study_id TEXT, html_key TEXT, json_key TEXT, created_at INTEGER
);
CREATE TABLE IF NOT EXISTS page_audit (
  study_id TEXT, page_path TEXT, session_id TEXT, step_id TEXT, violations TEXT, PRIMARY KEY (study_id, page_path, session_id)
);
CREATE TABLE IF NOT EXISTS event (seq INTEGER PRIMARY KEY AUTOINCREMENT, study_id TEXT, type TEXT, data TEXT, at INTEGER);
CREATE INDEX IF NOT EXISTS event_study ON event(study_id, seq);
"""


def _j(v: Any) -> str:
    return json.dumps(v)


def _p(v: Any) -> Any:
    return None if v is None else json.loads(v)


class Db:
    def __init__(self, file: Optional[str] = None):
        path = file or str(config.data_dir / "swarm.db")
        if path != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.sql = sqlite3.connect(path, check_same_thread=False, isolation_level=None, timeout=5)
        self.sql.row_factory = sqlite3.Row
        self._lock = threading.RLock()
        self.sql.execute("PRAGMA journal_mode = WAL")
        self.sql.execute("PRAGMA busy_timeout = 5000")
        self.sql.executescript(SCHEMA)
        # Migrations for databases created by older versions.
        cols = {r["name"] for r in self.sql.execute("PRAGMA table_info(study)")}
        for col, ddl in (("runner", "runner TEXT"), ("lease_until", "lease_until INTEGER DEFAULT 0"),
                         ("owner_id", "owner_id TEXT"), ("key_source", "key_source TEXT DEFAULT 'platform'")):
            if col not in cols:
                self.sql.execute(f"ALTER TABLE study ADD COLUMN {ddl}")

    def _x(self, q: str, args: tuple = ()) -> sqlite3.Cursor:
        with self._lock:
            return self.sql.execute(q, args)

    def _all(self, q: str, args: tuple = ()) -> list[sqlite3.Row]:
        with self._lock:
            return self.sql.execute(q, args).fetchall()

    def _one(self, q: str, args: tuple = ()) -> Optional[sqlite3.Row]:
        with self._lock:
            return self.sql.execute(q, args).fetchone()

    # ---------------- study / task / persona

    def insert_study(self, id: str, spec: StudySpec, owner_id: Optional[str] = None, key_source: str = "platform") -> None:
        d = spec.dump()
        self._x(
            "INSERT INTO study (id, name, target_url, allowed_domains, persona_mix, budget, spec, status, build_id, created_at, owner_id, key_source)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, 'planned', ?, ?, ?, ?)",
            (id, spec.name, spec.target, _j(spec.allowed_domains), _j(d["personas"]), _j(d["budget"]), _j(d), spec.build_id, now_ms(), owner_id, key_source),
        )
        for t in d["tasks"]:
            self._x("INSERT INTO task (id, study_id, goal_text, start_url, success_criteria) VALUES (?, ?, ?, ?, ?)",
                    (t["id"], id, t["goal"], t.get("start_url") or spec.target, _j(t)))

    def _study(self, r: sqlite3.Row) -> dict:
        return {
            "id": r["id"], "name": r["name"], "targetUrl": r["target_url"], "spec": _p(r["spec"]), "status": r["status"],
            "buildId": r["build_id"], "costUsd": float(r["cost_usd"] or 0), "createdAt": r["created_at"], "finishedAt": r["finished_at"],
            "ownerId": r["owner_id"], "keySource": r["key_source"] or "platform",
        }

    def study(self, id: str) -> Optional[dict]:
        r = self._one("SELECT * FROM study WHERE id = ?", (id,))
        return self._study(r) if r else None

    def studies(self) -> list[dict]:
        return [self._study(r) for r in self._all("SELECT * FROM study ORDER BY created_at DESC")]

    def set_study_status(self, id: str, status: str) -> None:
        self._x("UPDATE study SET status = ?, finished_at = CASE WHEN ? IN ('complete','stopped') THEN ? ELSE finished_at END WHERE id = ?",
                (status, status, now_ms(), id))

    def acquire_study_lease(self, id: str, runner: str, ttl_ms: int) -> bool:
        """Take (or renew) the study's lease. Succeeds only if nobody else holds a live lease."""
        now = now_ms()
        c = self._x("UPDATE study SET runner = ?, lease_until = ? WHERE id = ? AND (runner IS NULL OR runner = ? OR lease_until < ?)",
                    (runner, now + ttl_ms, id, runner, now))
        return c.rowcount == 1

    def release_study_lease(self, id: str, runner: str) -> None:
        self._x("UPDATE study SET runner = NULL, lease_until = 0 WHERE id = ? AND runner = ?", (id, runner))

    def study_lease(self, id: str) -> dict:
        r = self._one("SELECT runner, lease_until FROM study WHERE id = ?", (id,))
        return {"runner": r["runner"] if r else None, "leaseUntil": int(r["lease_until"] or 0) if r else 0}

    def claim_session(self, id: str) -> bool:
        """Atomically move a session from queued to provisioning; False if another worker got it first."""
        return self._x("UPDATE session SET status = 'provisioning' WHERE id = ? AND status = 'queued'", (id,)).rowcount == 1

    def add_study_cost(self, id: str, usd: float) -> float:
        self._x("UPDATE study SET cost_usd = cost_usd + ? WHERE id = ?", (usd, id))
        r = self._one("SELECT cost_usd FROM study WHERE id = ?", (id,))
        return float(r["cost_usd"]) if r else 0.0

    def tasks(self, study_id: str) -> list[TaskSpec]:
        return [TaskSpec.model_validate(_p(r["success_criteria"])) for r in self._all("SELECT success_criteria FROM task WHERE study_id = ? ORDER BY rowid", (study_id,))]

    def insert_persona(self, study_id: str, card: PersonaCard, perception: Any, action: Any, budget: Any) -> None:
        self._x("INSERT OR REPLACE INTO persona (id, study_id, card, perception_profile, action_profile, budget) VALUES (?, ?, ?, ?, ?, ?)",
                (card.id, study_id, card.model_dump_json(), _j(perception), _j(action), _j(budget)))

    def personas(self, study_id: str) -> list[PersonaCard]:
        return [PersonaCard.model_validate_json(r["card"]) for r in self._all("SELECT card FROM persona WHERE study_id = ? ORDER BY rowid", (study_id,))]

    # ---------------- session

    def insert_session(self, s: dict) -> None:
        self._x("INSERT INTO session (id, study_id, task_id, persona_id, repetition, seed, status) VALUES (?, ?, ?, ?, ?, ?, 'queued')",
                (s["id"], s["studyId"], s["taskId"], s["personaId"], s["repetition"], s["seed"]))

    _SESSION_COLS = {"status": "status", "outcome": "outcome", "outcomeDetail": "outcome_detail", "stepCount": "step_count", "cost": "cost",
                     "tokens": "tokens", "estHumanMs": "est_human_ms", "attempts": "attempts", "artifacts": "artifacts",
                     "startedAt": "started_at", "endedAt": "ended_at"}

    def update_session(self, id: str, **patch: Any) -> None:
        sets, vals = [], []
        for k, v in patch.items():
            col = self._SESSION_COLS.get(k)
            if not col:
                continue
            sets.append(f"{col} = ?")
            vals.append(_j(v) if k == "artifacts" else v)
        if sets:
            self._x(f"UPDATE session SET {', '.join(sets)} WHERE id = ?", (*vals, id))

    def _session(self, r: sqlite3.Row) -> dict:
        return {
            "id": r["id"], "studyId": r["study_id"], "taskId": r["task_id"], "personaId": r["persona_id"], "repetition": r["repetition"],
            "seed": r["seed"], "status": r["status"], "outcome": r["outcome"], "outcomeDetail": r["outcome_detail"],
            "stepCount": r["step_count"] or 0, "cost": float(r["cost"] or 0), "tokens": r["tokens"] or 0, "estHumanMs": r["est_human_ms"] or 0,
            "attempts": r["attempts"] or 0, "artifacts": _p(r["artifacts"]) or {}, "startedAt": r["started_at"], "endedAt": r["ended_at"],
        }

    def session(self, id: str) -> Optional[dict]:
        r = self._one("SELECT * FROM session WHERE id = ?", (id,))
        return self._session(r) if r else None

    def sessions(self, study_id: str) -> list[dict]:
        return [self._session(r) for r in self._all("SELECT * FROM session WHERE study_id = ? ORDER BY rowid", (study_id,))]

    # ---------------- step / signal

    def insert_step(self, s: dict) -> None:
        self._x(
            "INSERT INTO step (id, session_id, idx, url, page_path, title, state_hash, action, think_aloud, expectation, confidence,"
            " frustration, target, observation, artifacts, tokens_in, tokens_out, cost, model, est_human_ms, started_at, ended_at)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (s["id"], s["sessionId"], s["idx"], s["url"], s["pagePath"], s["title"], s["stateHash"], _j(s["action"]), s["thinkAloud"],
             _j(s["expectation"]), s["confidence"], s["frustration"], _j(s.get("target")), _j(s["observation"]), _j(s["artifacts"]),
             s["tokensIn"], s["tokensOut"], s["costUsd"], s["model"], s["estHumanMs"], s["startedAt"], s["endedAt"]),
        )

    def _step(self, r: sqlite3.Row) -> dict:
        return {
            "id": r["id"], "sessionId": r["session_id"], "idx": r["idx"], "url": r["url"], "pagePath": r["page_path"], "title": r["title"] or "",
            "stateHash": r["state_hash"], "action": _p(r["action"]), "thinkAloud": r["think_aloud"] or "", "expectation": _p(r["expectation"]),
            "confidence": r["confidence"], "frustration": r["frustration"], "target": _p(r["target"]), "observation": _p(r["observation"]),
            "artifacts": _p(r["artifacts"]) or {}, "tokensIn": r["tokens_in"], "tokensOut": r["tokens_out"], "costUsd": float(r["cost"] or 0),
            "model": r["model"], "estHumanMs": r["est_human_ms"], "startedAt": r["started_at"], "endedAt": r["ended_at"],
        }

    def steps(self, session_id: str) -> list[dict]:
        return [self._step(r) for r in self._all("SELECT * FROM step WHERE session_id = ? ORDER BY idx", (session_id,))]

    def step(self, id: str) -> Optional[dict]:
        r = self._one("SELECT * FROM step WHERE id = ?", (id,))
        return self._step(r) if r else None

    def last_steps(self, study_id: str) -> list[dict]:
        """Latest step per session, for the live wall's first paint."""
        return [self._step(r) for r in self._all(
            "SELECT st.* FROM step st JOIN (SELECT session_id, MAX(idx) m FROM step WHERE session_id IN (SELECT id FROM session WHERE study_id = ?)"
            " GROUP BY session_id) last ON st.session_id = last.session_id AND st.idx = last.m", (study_id,))]

    def replace_signals(self, session_id: str, signals: list[dict]) -> None:
        with self._lock:
            self.sql.execute("DELETE FROM signal WHERE session_id = ?", (session_id,))
            self.sql.executemany("INSERT INTO signal (id, step_id, session_id, type, details) VALUES (?, ?, ?, ?, ?)",
                                 [(s["id"], s["stepId"], s["sessionId"], s["type"], _j(s["details"])) for s in signals])

    def signals(self, session_id: str) -> list[dict]:
        return [{"id": r["id"], "stepId": r["step_id"], "sessionId": r["session_id"], "type": r["type"], "details": _p(r["details"])}
                for r in self._all("SELECT * FROM signal WHERE session_id = ?", (session_id,))]

    # ---------------- candidates / issues

    def replace_candidates(self, session_id: str, study_id: str, cands: list[dict]) -> None:
        with self._lock:
            self.sql.execute("DELETE FROM candidate_issue WHERE session_id = ?", (session_id,))
            self.sql.executemany("INSERT INTO candidate_issue (id, session_id, study_id, data, embedding) VALUES (?, ?, ?, ?, ?)",
                                 [(c["id"], session_id, study_id, _j({k: v for k, v in c.items() if k != "embedding"}), _j(c["embedding"])) for c in cands])

    def candidates(self, study_id: str) -> list[dict]:
        return [{**_p(r["data"]), "embedding": _p(r["embedding"])} for r in self._all("SELECT data, embedding FROM candidate_issue WHERE study_id = ?", (study_id,))]

    def replace_issues(self, study_id: str, issues: list[dict]) -> None:
        with self._lock:
            self.sql.execute("DELETE FROM issue WHERE study_id = ?", (study_id,))
            self.sql.executemany("INSERT INTO issue (id, study_id, severity, data) VALUES (?, ?, ?, ?)",
                                 [(i["id"], study_id, i["severity"], _j(i)) for i in issues])

    def issues(self, study_id: str) -> list[dict]:
        return [_p(r["data"]) for r in self._all("SELECT data FROM issue WHERE study_id = ? ORDER BY severity DESC", (study_id,))]

    # ---------------- audits / reports / events

    def upsert_audit(self, study_id: str, page_path: str, session_id: str, step_id: str, violations: Any) -> None:
        self._x("INSERT OR REPLACE INTO page_audit (study_id, page_path, session_id, step_id, violations) VALUES (?, ?, ?, ?, ?)",
                (study_id, page_path, session_id, step_id, _j(violations)))

    def audits(self, study_id: str) -> list[dict]:
        return [{"pagePath": r["page_path"], "sessionId": r["session_id"], "stepId": r["step_id"], "violations": _p(r["violations"]) or []}
                for r in self._all("SELECT * FROM page_audit WHERE study_id = ?", (study_id,))]

    def insert_report(self, id: str, study_id: str, version: int, compared_to: Optional[str], html_key: str, json_key: str) -> None:
        self._x("INSERT INTO report (id, study_id, version, compared_to_study_id, html_key, json_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (id, study_id, version, compared_to, html_key, json_key, now_ms()))

    def latest_report_version(self, study_id: str) -> int:
        r = self._one("SELECT MAX(version) v FROM report WHERE study_id = ?", (study_id,))
        return int(r["v"] or 0) if r else 0

    def last_event_seq(self, study_id: str) -> int:
        r = self._one("SELECT MAX(seq) s FROM event WHERE study_id = ?", (study_id,))
        return int(r["s"] or 0) if r else 0

    def append_event(self, study_id: str, type: str, data: Any) -> int:
        return int(self._x("INSERT INTO event (study_id, type, data, at) VALUES (?, ?, ?, ?)", (study_id, type, _j(data), now_ms())).lastrowid)

    def events(self, study_id: str, after_seq: int = 0) -> list[dict]:
        return [{"seq": r["seq"], "type": r["type"], "data": _p(r["data"]), "at": r["at"], "studyId": study_id}
                for r in self._all("SELECT * FROM event WHERE study_id = ? AND seq > ? ORDER BY seq", (study_id, after_seq))]
