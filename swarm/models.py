"""Shared schemas. Everything that crosses a module boundary or touches disk is validated here, so a malformed
persona card or study file fails loudly at load time. Runtime records (steps, signals, issues) are plain dicts
with camelCase keys: they are stored as JSON and served to the dashboard unchanged."""
from __future__ import annotations

from typing import Annotated, Any, Literal, Optional, Union

from pydantic import BaseModel, ConfigDict, Field, HttpUrl, field_validator


class _M(BaseModel):
    model_config = ConfigDict(extra="ignore")


# ---------------------------------------------------------------- personas

ReadingStyle = Literal["skim", "normal", "thorough"]
NetworkProfile = Literal["fast", "4g", "slow-4g", "3g"]
ColorVision = Literal["normal", "deuteranopia", "protanopia", "tritanopia", "achromatopsia"]


class Device(_M):
    viewport: str = Field("1280x800", pattern=r"^\d+x\d+$")
    touch: bool = False
    network: NetworkProfile = "fast"
    mobile: Optional[bool] = None


class Patience(_M):
    max_steps: int = Field(30, ge=3, le=200)
    max_retries_per_obstacle: int = Field(3, ge=0, le=10)


class Accessibility(_M):
    zoom: float = Field(100, ge=50, le=400)
    screen_reader: bool = False
    keyboard_only: bool = False
    color_vision: ColorVision = "normal"


class Geo(_M):
    latitude: float
    longitude: float


class PersonaCard(_M):
    id: str = Field(pattern=r"^[a-z0-9-]+$")
    name: str
    archetype: str
    locale: str = "en-US"
    non_native: bool = False
    device: Device = Field(default_factory=Device)
    digital_literacy: int = Field(ge=1, le=5)
    domain_knowledge: int = Field(ge=1, le=5)
    goal_framing: Optional[str] = None
    reading: ReadingStyle = "normal"
    patience: Patience = Field(default_factory=Patience)
    accessibility: Accessibility = Field(default_factory=Accessibility)
    quirks: list[str] = []
    # Words the persona does not understand. Enforced in the prompt (spec: "Knowledge and language").
    vocabulary_gaps: list[str] = []
    # Optional per-persona step model, to counter the "homogeneity" bias by mixing models.
    model: Optional[str] = None
    timezone: Optional[str] = None
    geolocation: Optional[Geo] = None
    # Free-form demographic tags used by the stratified sampler.
    tags: list[str] = []


# ---------------------------------------------------------------- study

class NetworkRule(_M):
    method: str = "POST"
    url_pattern: str
    status: Optional[int] = None


class SuccessCriteria(_M):
    mode: Literal["all", "any"] = "any"
    url_pattern: Optional[str] = None
    text_present: Optional[str] = None
    network: Optional[NetworkRule] = None
    # Fuzzy goals: an LLM judge reads the final screenshot against this description.
    llm_judge: Optional[str] = None


class Fill(_M):
    selector: str
    secret: Optional[str] = None
    value: Optional[str] = None


class ScriptStep(_M):
    """Scripted steps run before the persona starts, outside the model: logins (secrets come from env vars)
    and setup such as putting an item in the bag so a task can start at checkout."""
    goto: Optional[str] = None
    fill: Optional[Fill] = None
    click: Optional[str] = None
    wait_for_url: Optional[str] = None
    wait_ms: Optional[int] = Field(None, ge=0, le=30_000)


class TaskSpec(_M):
    id: str
    goal: str
    start_url: Optional[str] = None
    success: SuccessCriteria
    auth: Optional[list[ScriptStep]] = None
    setup: Optional[list[ScriptStep]] = None
    # Actions like "Place order" are blocked unless the study allows them (spec: safety rules).
    allow_irreversible: bool = True


class Budget(_M):
    repetitions: int = Field(3, ge=1, le=10)
    max_steps: Optional[int] = Field(None, ge=3, le=200)
    wall_clock_minutes: float = Field(10, ge=0.5, le=60)
    tokens_per_session: int = 400_000
    cost_cap_usd: float = Field(1, ge=0)
    concurrency: int = Field(6, ge=1, le=100)


class Generate(_M):
    segment: str
    count: int = Field(ge=1, le=50)


class PersonaMix(_M):
    include: list[str] = []
    generate: list[Generate] = []
    seeded_from: Optional[str] = None
    size: Optional[int] = Field(None, ge=1, le=100)
    mobile_share: Optional[float] = Field(None, ge=0, le=1)


class StudySpec(_M):
    name: str
    target_url: HttpUrl
    allowed_domains: list[str] = Field(min_length=1)
    # Must be true: only test sites you own or have written permission to test.
    permission_confirmed: Literal[True]
    tasks: list[TaskSpec] = Field(min_length=1, max_length=5)
    personas: PersonaMix
    budget: Budget = Field(default_factory=Budget)
    reset_url: Optional[str] = None
    build_id: Optional[str] = None
    compare_to: Optional[str] = None
    # Stay out of paths the target's robots.txt disallows.
    respect_robots: bool = True
    seed: int = 42

    @field_validator("permission_confirmed", mode="before")
    @classmethod
    def _perm(cls, v: Any) -> Any:
        if v is not True:
            raise ValueError("permission_confirmed must be true: only test sites you own or have written permission to test")
        return v

    def dump(self) -> dict:
        d = self.model_dump(mode="json", exclude_none=True)
        d["target_url"] = str(self.target_url)
        return d

    @property
    def target(self) -> str:
        return str(self.target_url)


# ---------------------------------------------------------------- agent I/O (LLM-facing)

class CUrlChanges(_M):
    type: Literal["url_changes"]


class CUrlContains(_M):
    type: Literal["url_contains"]
    value: str


class CTextAppears(_M):
    type: Literal["text_appears"]
    value: str


class CTextChanges(_M):
    type: Literal["text_changes"]
    mark: int


class CElementChanges(_M):
    type: Literal["element_changes"]
    mark: int


class CDialogOpens(_M):
    type: Literal["dialog_opens"]


class CFocusMoves(_M):
    type: Literal["focus_moves"]


class CNone(_M):
    type: Literal["none"]


ExpectationCheck = Annotated[
    Union[CUrlChanges, CUrlContains, CTextAppears, CTextChanges, CElementChanges, CDialogOpens, CFocusMoves, CNone],
    Field(discriminator="type"),
]


class AClick(_M):
    type: Literal["click"]
    mark: int


class ATap(_M):
    type: Literal["tap"]
    mark: int


class AType(_M):
    type: Literal["type"]
    mark: int
    text: str
    submit: Optional[bool] = None


class ASelect(_M):
    type: Literal["select"]
    mark: int
    option: str


class AScroll(_M):
    type: Literal["scroll"]
    direction: Literal["down", "up"]


class AHover(_M):
    type: Literal["hover"]
    mark: int


class APress(_M):
    type: Literal["press"]
    key: str
    times: Optional[int] = None


class ABack(_M):
    type: Literal["back"]


class AWait(_M):
    type: Literal["wait"]
    seconds: float


class AGoto(_M):
    type: Literal["goto"]
    url: str


class AGiveUp(_M):
    type: Literal["give_up"]
    reason: str


class ADone(_M):
    type: Literal["done"]
    claim: str


AgentAction = Annotated[
    Union[AClick, ATap, AType, ASelect, AScroll, AHover, APress, ABack, AWait, AGoto, AGiveUp, ADone],
    Field(discriminator="type"),
]


class Expectation(_M):
    says: str
    check: ExpectationCheck


class AgentStep(_M):
    """The step model's answer. Ranges are clamped after parsing, so an odd value never kills a step."""
    think_aloud: str
    confidence: float
    frustration: float
    action: AgentAction
    expectation: Expectation
    note: Optional[str] = None


# ---------------------------------------------------------------- issues

NIELSEN_HEURISTICS = [
    "visibility_of_system_status", "match_between_system_and_real_world", "user_control_and_freedom",
    "consistency_and_standards", "error_prevention", "recognition_rather_than_recall",
    "flexibility_and_efficiency_of_use", "aesthetic_and_minimalist_design",
    "help_users_recognize_diagnose_recover_from_errors", "help_and_documentation",
]
Heuristic = Literal[
    "visibility_of_system_status", "match_between_system_and_real_world", "user_control_and_freedom",
    "consistency_and_standards", "error_prevention", "recognition_rather_than_recall",
    "flexibility_and_efficiency_of_use", "aesthetic_and_minimalist_design",
    "help_users_recognize_diagnose_recover_from_errors", "help_and_documentation",
]
Impact = Literal["blocked", "major_detour", "minor_friction", "cosmetic"]
IMPACT_SCORE = {"blocked": 4, "major_detour": 3, "minor_friction": 2, "cosmetic": 1}


class CandidateDraft(_M):
    title: str
    description: str
    page: str
    element: str
    heuristic: Heuristic
    impact: Impact
    step_ids: list[str] = Field(min_length=1)
    quotes: list[str] = []
    suggested_fix: Optional[str] = None


TERMINAL_STATUSES = {"succeeded", "gave_up", "failed", "infra_error", "timed_out", "analysed"}
ACTIVE_STATUSES = {"queued", "provisioning", "running"}
