"""Runtime configuration from environment variables (and .env), with defaults that match the spec while
staying cheap: every role defaults to one inexpensive vision model on OpenRouter."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _load_dotenv(path: Path) -> None:
    """Minimal .env loader. Real environment variables win."""
    if not path.exists():
        return
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        value = value.strip().strip('"').strip("'")
        os.environ.setdefault(key.strip(), value)


_load_dotenv(Path.cwd() / ".env")
env = os.environ
CHEAP = "anthropic/claude-haiku-5.5"


def _num(name: str, default: float) -> float:
    v = env.get(name)
    return default if v in (None, "") else float(v)


def _list(name: str) -> list[str]:
    return [x.strip().lower() for x in env.get(name, "").split(",") if x.strip()]


@dataclass
class Models:
    step: str = env.get("SWARM_STEP_MODEL", CHEAP)
    escalation: str = env.get("SWARM_ESCALATION_MODEL", CHEAP)
    critic: str = env.get("SWARM_CRITIC_MODEL", CHEAP)
    synthesis: str = env.get("SWARM_SYNTHESIS_MODEL", CHEAP)
    judge: str = env.get("SWARM_JUDGE_MODEL", CHEAP)
    generator: str = env.get("SWARM_GENERATOR_MODEL", CHEAP)
    # Only for scoring the seeded-defect benchmark: rare and small, so a stronger judge is affordable.
    benchmark: str = env.get("SWARM_BENCHMARK_MODEL", "anthropic/claude-sonnet-5.5")


@dataclass
class Effort:
    step: str = env.get("SWARM_STEP_EFFORT", "low")
    escalation: str = env.get("SWARM_ESCALATION_EFFORT", "high")
    critic: str = env.get("SWARM_CRITIC_EFFORT", "medium")


@dataclass
class Limits:
    free_runs: int = int(_num("SWARM_FREE_RUNS", 1))
    free_max_sessions: int = int(_num("SWARM_FREE_MAX_SESSIONS", 6))
    free_max_steps: int = int(_num("SWARM_FREE_MAX_STEPS", 20))
    free_cost_cap_usd: float = _num("SWARM_FREE_COST_CAP_USD", 0.1)
    # All free runs together may spend at most this per UTC day on the platform key.
    platform_daily_cap_usd: float = _num("SWARM_PLATFORM_DAILY_CAP_USD", 0.5)
    user_max_sessions: int = int(_num("SWARM_USER_MAX_SESSIONS", 24))
    max_active_studies: int = int(_num("SWARM_MAX_ACTIVE_STUDIES", 2))

    def public(self) -> dict:
        return {
            "freeRuns": self.free_runs, "freeMaxSessions": self.free_max_sessions, "freeMaxSteps": self.free_max_steps,
            "freeCostCapUsd": self.free_cost_cap_usd, "platformDailyCapUsd": self.platform_daily_cap_usd,
            "userMaxSessions": self.user_max_sessions, "maxActiveStudies": self.max_active_studies,
        }


@dataclass
class Config:
    data_dir: Path = Path(env.get("SWARM_DATA_DIR", "data")).resolve()
    # Render (and most hosts) inject PORT.
    port: int = int(env.get("SWARM_PORT") or env.get("PORT") or 4300)
    host: str = env.get("SWARM_HOST", "127.0.0.1")
    # Public origin, used for the Google OAuth redirect. Render sets RENDER_EXTERNAL_URL.
    public_url: str = (env.get("PUBLIC_URL") or env.get("RENDER_EXTERNAL_URL") or "").rstrip("/")
    # "live" calls models through OpenRouter; "mock" uses a deterministic policy and critic (tests, CI, offline).
    model_mode: str = env.get("SWARM_MODEL_MODE") or ("live" if env.get("OPENROUTER_API_KEY") else "mock")
    models: Models = field(default_factory=Models)
    effort: Effort = field(default_factory=Effort)
    escalation_steps: int = 3
    # Credit guards: never spend below this reserve, and cap every study at the credit actually left.
    credit_reserve_usd: float = _num("SWARM_CREDIT_RESERVE_USD", 0.5)
    # Longest screenshot side sent to the model; smaller images cost fewer input tokens.
    model_image_max_width: int = int(_num("SWARM_IMAGE_MAX_WIDTH", 1024))
    google_client_id: str = env.get("GOOGLE_CLIENT_ID", "")
    google_client_secret: str = env.get("GOOGLE_CLIENT_SECRET", "")
    admin_emails: list[str] = field(default_factory=lambda: _list("SWARM_ADMIN_EMAILS"))
    database_url: str = env.get("DATABASE_URL", "")
    limits: Limits = field(default_factory=Limits)
    # host or host:port entries the browsers may reach although private (e.g. the bundled demo shop).
    private_hosts_allowed: list[str] = field(default_factory=lambda: _list("SWARM_PRIVATE_HOSTS_ALLOWED"))
    demo_shop: bool = env.get("SWARM_DEMO_SHOP") == "1"
    demo_shop_port: int = int(_num("SWARM_DEMO_SHOP_PORT", 4400))
    user_agent_suffix: str = env.get("SWARM_UA", "SyntheticUserSwarm/0.1 (+usability testing; contact site owner)")
    headless: bool = env.get("SWARM_HEADFUL") != "1"
    per_domain_concurrency: int = int(_num("SWARM_PER_DOMAIN_CONCURRENCY", 8))
    history_steps: int = 6


config = Config()


def multi_user() -> bool:
    return bool(config.google_client_id)


def reload() -> None:
    """Re-read the environment (tests set variables after import)."""
    global config
    fresh = Config()
    config.__dict__.update(fresh.__dict__)
