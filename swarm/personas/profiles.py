"""Maps each persona trait to the mechanism that enforces it (spec, Persona engine table):
browser context, perception filter, action filter, budget, prompt."""
from __future__ import annotations

from typing import Optional

from ..models import PersonaCard


def perception_profile(card: PersonaCard) -> dict:
    return {
        # Screen reader: no screenshot at all, only the accessibility tree in reading order.
        "screenshot": "none" if card.accessibility.screen_reader else "full",
        "colorVision": card.accessibility.color_vision,
        # Skimmers see headings, buttons and the first ~12 words of each text block.
        "skim": card.reading == "skim",
        "skimWords": 12,
        "zoom": card.accessibility.zoom,
    }


def action_profile(card: PersonaCard) -> dict:
    return {
        "keyboardOnly": card.accessibility.keyboard_only or card.accessibility.screen_reader,
        # Real users don't guess URLs; letting the agent do it hides navigation problems.
        "allowGoto": False,
        "touch": card.device.touch,
    }


def persona_budget(card: PersonaCard, max_steps: Optional[int], wall_clock_minutes: float, tokens: int) -> dict:
    return {
        "maxSteps": min(card.patience.max_steps, max_steps if max_steps is not None else 10**9),
        "maxRetriesPerObstacle": card.patience.max_retries_per_obstacle,
        "wallClockMs": int(wall_clock_minutes * 60_000),
        "maxTokens": tokens,
    }


def is_mobile(card: PersonaCard) -> bool:
    if card.device.mobile is not None:
        return card.device.mobile
    w = int(card.device.viewport.split("x")[0])
    return card.device.touch and w < 900


def context_options(card: PersonaCard, user_agent_suffix: str) -> dict:
    """Device and network are enforced through the browser context. Zoom is emulated the way a browser does it:
    a smaller CSS viewport rendered at a higher device scale factor."""
    w, h = (int(x) for x in card.device.viewport.split("x"))
    zoom = card.accessibility.zoom / 100
    mobile = is_mobile(card)
    base_ua = (
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36"
        if mobile else
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"
    )
    opts = {
        "viewport": {"width": round(w / zoom), "height": round(h / zoom)},
        "device_scale_factor": zoom,
        "is_mobile": mobile,
        "has_touch": card.device.touch,
        "locale": card.locale,
        "timezone_id": card.timezone or "UTC",
        "permissions": ["geolocation"] if card.geolocation else [],
        "user_agent": f"{base_ua} {user_agent_suffix}",
        "reduced_motion": "reduce",
        "color_scheme": "light",
    }
    if card.geolocation:
        opts["geolocation"] = {"latitude": card.geolocation.latitude, "longitude": card.geolocation.longitude}
    return opts


# Chromium CDP network conditions per profile (download/upload in bytes/s, latency ms).
NETWORK_CONDITIONS: dict[str, Optional[dict]] = {
    "fast": None,
    "4g": {"latency": 60, "download": (9 * 1024 * 1024) / 8, "upload": (3 * 1024 * 1024) / 8},
    "slow-4g": {"latency": 150, "download": (1.6 * 1024 * 1024) / 8, "upload": (750 * 1024) / 8},
    "3g": {"latency": 300, "download": (750 * 1024) / 8, "upload": (250 * 1024) / 8},
}


def reading_wpm(card: PersonaCard) -> float:
    """Words per minute by reading style and literacy, for the time-on-task estimate."""
    base = {"skim": 450, "normal": 240, "thorough": 170}[card.reading]
    literacy = 0.6 + 0.1 * card.digital_literacy  # 0.7 .. 1.1
    language = 0.75 if card.non_native else 1
    return base * literacy * language
