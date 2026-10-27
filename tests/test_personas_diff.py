import pytest
from pydantic import ValidationError

from swarm.analysis.synthesis import fingerprint
from swarm.models import PersonaCard, StudySpec
from swarm.personas.library import dedupe_personas, load_curated_personas, stratified_sample
from swarm.personas.profiles import action_profile, context_options, is_mobile, perception_profile
from swarm.report.diff import diff_issues
from swarm.runtime.actions import allowed_actions

LIB = load_curated_personas()


def by_id(pid):
    return next(p for p in LIB if p.id == pid)


class TestPersonaEngine:
    def test_loads_12_cards(self):
        assert len(LIB) == 12 and "asha-68-mobile" in [p.id for p in LIB]

    def test_rejects_malformed(self):
        with pytest.raises(ValidationError):
            PersonaCard.model_validate({"id": "Bad Id", "name": "x", "archetype": "y", "digital_literacy": 9, "domain_knowledge": 1})

    def test_traits_are_mechanisms(self):
        sam = by_id("sam-screen-reader")
        assert perception_profile(sam)["screenshot"] == "none" and action_profile(sam)["keyboardOnly"]
        assert "click" not in allowed_actions(action_profile(by_id("ravi-keyboard")), False)
        asha = by_id("asha-68-mobile")
        assert perception_profile(asha)["skim"]
        # 150% zoom: a smaller CSS viewport at a higher device scale factor.
        ctx = context_options(asha, "ua")
        assert ctx["viewport"] == {"width": 260, "height": 563} and ctx["device_scale_factor"] == 1.5 and ctx["has_touch"]
        assert is_mobile(asha)

    def test_goto_never_offered(self):
        for p in LIB:
            assert "goto" not in allowed_actions(action_profile(p), perception_profile(p)["screenshot"] == "none")

    def test_stratified_sampling(self):
        pick = stratified_sample(LIB, 6, 0.5, 1)
        assert len(pick) == 6 and sum(1 for p in pick if is_mobile(p)) == 3

    def test_dedupe(self):
        twin = LIB[0].model_copy(update={"id": "asha-twin", "name": "Asha 2"})
        assert len(dedupe_personas([LIB[0], twin, LIB[1]])) == 2


BASE = {"name": "t", "target_url": "http://localhost:4400/", "allowed_domains": ["localhost"], "permission_confirmed": True,
        "tasks": [{"id": "a", "goal": "g", "success": {"url_pattern": "/x"}}], "personas": {"include": []}}


class TestStudySpec:
    def test_requires_permission(self):
        with pytest.raises(ValidationError):
            StudySpec.model_validate({**BASE, "permission_confirmed": False})
        StudySpec.model_validate(BASE)

    def test_one_to_five_tasks(self):
        for tasks in ([], [BASE["tasks"][0]] * 6):
            with pytest.raises(ValidationError):
                StudySpec.model_validate({**BASE, "tasks": tasks})


def issue(id, title, page, element, sev, sessions=3):
    return {"id": id, "studyId": "s", "taskIds": ["t"], "title": title, "description": title, "page": page, "element": element,
            "heuristic": "visibility_of_system_status", "impact": "blocked", "severity": sev, "confidence": "high", "needsReview": False,
            "reach": {"sessions": sessions, "sessionsReachedPage": 6, "personas": 2, "repetitions": 2, "label": ""},
            "personaIds": [], "candidateIds": [], "evidenceStepIds": [], "quotes": [], "signalTypes": [], "status": "open",
            "fingerprint": fingerprint(page, element, "visibility_of_system_status")}


def test_run_diff_labels():
    base = [issue("b1", "Checkout hidden under cookie banner", "/bag", "Checkout", 3), issue("b2", "Add to bag gives no feedback", "/products/:id", "Add to bag", 2),
            issue("b3", "Coupon does nothing", "/bag", "Apply", 1.2)]
    head = [issue("h1", "Checkout covered by banner", "/bag", "Checkout", 3), issue("h2", "Add to bag shows nothing", "/products/:id", "Add to bag", 3.2, 6),
            issue("h3", "Phone field fails silently", "/checkout", "Phone", 3.5)]
    d = diff_issues(base, head)
    by = {r["headIssueId"] or r["baseIssueId"]: r["status"] for r in d["rows"]}
    assert (by["h1"], by["h2"], by["h3"], by["b3"]) == ("unchanged", "regressed", "new", "fixed")
    assert d["counts"] == {"new": 1, "fixed": 1, "regressed": 1, "unchanged": 1}
