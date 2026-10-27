"""Event stream feeding the live dashboard. Every event is persisted (so a late viewer, or another process,
can replay from any seq) and fanned out in-process to subscribers. Swap for Redis Streams/NATS by
re-implementing publish/subscribe."""
from __future__ import annotations

from typing import Any, Callable

from ..util import now_ms
from .db import Db


class EventBus:
    def __init__(self, db: Db):
        self.db = db
        self._subs: dict[str, list[Callable[[dict], None]]] = {}

    def publish(self, study_id: str, type: str, data: Any) -> None:
        seq = self.db.append_event(study_id, type, data)
        ev = {"seq": seq, "studyId": study_id, "type": type, "data": data, "at": now_ms()}
        for fn in list(self._subs.get(study_id, [])) + list(self._subs.get("*", [])):
            try:
                fn(ev)
            except Exception:  # a broken subscriber must never break the swarm
                pass

    def subscribe(self, study_id: str, fn: Callable[[dict], None]) -> Callable[[], None]:
        self._subs.setdefault(study_id, []).append(fn)
        return lambda: self._subs.get(study_id, []).remove(fn) if fn in self._subs.get(study_id, []) else None

    def replay(self, study_id: str, after_seq: int = 0) -> list[dict]:
        return self.db.events(study_id, after_seq)
