"""Severity and confidence rules, exactly as the spec defines them."""
from __future__ import annotations

from typing import Optional

from ..models import IMPACT_SCORE


def severity(impact: str, sessions_affected: int, sessions_reached_page: int) -> float:
    """severity = impact x (0.5 + 0.5 * sessions affected / sessions that reached the page). Dividing by sessions
    that reached the page stops late-funnel issues from being underrated. Result lies on Nielsen's 0-4 scale."""
    reached = max(sessions_reached_page, sessions_affected, 1)
    s = IMPACT_SCORE[impact] * (0.5 + 0.5 * (sessions_affected / reached))
    return round(s * 100) / 100


def severity_label(s: float) -> str:
    if s >= 3.5:
        return "catastrophic"
    if s >= 2.5:
        return "major"
    if s >= 1.5:
        return "minor"
    if s >= 0.5:
        return "cosmetic"
    return "not a problem"


DETERMINISTIC = {
    "dead_click", "rage_click", "expectation_mismatch", "backtrack", "loop", "error_shown", "search_miss",
    "scroll_hunt", "stall", "give_up", "task_failed", "accessibility", "layout", "slow_response",
}


def confidence(signal_types: list[str], personas: int, sessions: int, repetitions_hit: int, persona_passed_elsewhere: bool) -> dict:
    """High: a deterministic signal plus 2+ personas, repeated across runs. Medium: LLM-identified, but repeated
    across sessions or personas. Low: one session only, or the same persona passed on other repetitions."""
    has_signal = any(t in DETERMINISTIC for t in signal_types)
    if has_signal and personas >= 2 and repetitions_hit >= 2:
        return {"level": "high", "needsReview": False}
    if sessions <= 1 or (personas <= 1 and persona_passed_elsewhere):
        return {"level": "low", "needsReview": True}
    return {"level": "medium", "needsReview": False}


def reach_label(sessions: int, reached: int, personas: int, segment: Optional[str] = None) -> str:
    """Reach label for an issue card: "5 of 6 mobile sessions, 3 personas"."""
    return f"{sessions} of {reached}{' ' + segment if segment else ''} sessions, {personas} persona{'' if personas == 1 else 's'}"
