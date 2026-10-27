import pytest

from swarm.analysis.cluster import agglomerative
from swarm.analysis.embed import cosine, embed_text
from swarm.analysis.severity import confidence, severity, severity_label
from swarm.analysis.signals import detect_signals
from swarm.analysis.validator import validate_candidate
from swarm.models import CandidateDraft, SuccessCriteria
from swarm.runtime.check import check_success, expectation_met
from swarm.util import page_path, redact

from .helpers import step


def types(sigs):
    return [s["type"] for s in sigs]


class TestSeverity:
    def test_spec_formula(self):
        assert severity("blocked", 5, 6) == pytest.approx(4 * (0.5 + 0.5 * 5 / 6), abs=0.01)
        assert severity("minor_friction", 1, 10) == pytest.approx(2 * 0.55, abs=0.01)
        assert severity("cosmetic", 3, 3) == 1

    def test_divides_by_sessions_that_reached_the_page(self):
        # 3 of 3 sessions that reached checkout, even though 72 sessions ran overall.
        assert severity("blocked", 3, 3) == 4

    def test_never_divides_by_fewer_sessions_than_affected(self):
        assert severity("major_detour", 4, 2) == 3

    def test_labels(self):
        assert [severity_label(x) for x in (4, 2.7, 1.6, 1)] == ["catastrophic", "major", "minor", "cosmetic"]


class TestConfidence:
    def test_high(self):
        assert confidence(["dead_click"], 2, 4, 2, False)["level"] == "high"

    def test_medium(self):
        assert confidence([], 2, 2, 1, False)["level"] == "medium"

    def test_low_one_session(self):
        assert confidence(["dead_click"], 1, 1, 1, False) == {"level": "low", "needsReview": True}

    def test_low_persona_passed_elsewhere(self):
        assert confidence(["layout"], 1, 2, 2, True)["needsReview"] is True


class TestSignals:
    def test_dead_click(self):
        assert "dead_click" in types(detect_signals([step(obs={"domChanged": False, "networkCalls": 0})], None))

    def test_field_click_is_not_dead(self):
        s = step(obs={"domChanged": False}, target={"mark": 2, "selector": "#q", "name": "Search", "role": "searchbox", "box": {"x": 0, "y": 0, "width": 10, "height": 10}})
        assert "dead_click" not in types(detect_signals([s], None))

    def test_rage_click(self):
        steps = [step(idx=i, obs={"domChanged": False}) for i in range(3)]
        assert types(detect_signals(steps, None)).count("rage_click") == 1

    def test_expectation_mismatch(self):
        assert "expectation_mismatch" in types(detect_signals([step(obs={"expectationMet": False})], None))

    def test_loop(self):
        steps = [step(idx=i, stateHash="same", action={"type": "scroll", "direction": "down"}, target=None) for i in range(3)]
        assert "loop" in types(detect_signals(steps, None))

    def test_scroll_hunt(self):
        steps = [step(idx=i, action={"type": "scroll", "direction": "down"}, target=None) for i in range(4)]
        assert "scroll_hunt" in types(detect_signals(steps, None))

    def test_search_error_layout_a11y(self):
        s = step(obs={"searchZeroResults": True, "validationMessages": ["Phone is invalid"], "targetCovered": True},
                 target={"mark": 3, "selector": "button.icon", "name": "", "role": "button", "box": {"x": 0, "y": 0, "width": 10, "height": 10}})
        assert {"search_miss", "error_shown", "layout", "accessibility"} <= set(types(detect_signals([s], None)))

    def test_keyboard_trap(self):
        steps = [step(idx=i, action={"type": "press", "key": "Tab", "times": 2}, target=None, obs={"focusedAfter": "#a" if i % 2 else "#b"}) for i in range(4)]
        assert any(s["type"] == "accessibility" and s["details"]["kind"] == "keyboard_trap" for s in detect_signals(steps, None))

    def test_outcome_signals(self):
        assert "give_up" in types(detect_signals([step()], {"status": "gave_up", "detail": "too hard"}))
        assert "task_failed" in types(detect_signals([step()], {"status": "timed_out"}))

    def test_new_detectors(self):
        s = step(obs={"targetMoved": {"dx": 0, "dy": 72}, "slowRequest": {"url": "http://x/api/orders", "method": "POST", "ms": 3600, "domChangedWhileWaiting": False}, "loadShift": 0.06})
        sigs = detect_signals([s], None)
        kinds = {x["details"].get("kind") for x in sigs if x["type"] == "layout"}
        assert {"moved_before_tap", "load_shift"} <= kinds
        slow = next(x for x in sigs if x["type"] == "slow_response")
        assert slow["details"]["ms"] == 3600 and slow["details"]["progressShown"] is False


class TestValidator:
    s1 = step(idx=1, thinkAloud="I tapped Checkout but nothing happened at all.", obs={"domChanged": False})
    signals = detect_signals([s1], None)
    names = {s1["id"]: ["Checkout", "Continue shopping"]}

    def draft(self, **over):
        d = {"title": "Checkout does nothing", "description": "", "page": "/bag", "element": "Checkout", "heuristic": "visibility_of_system_status",
             "impact": "blocked", "step_ids": [self.s1["id"]], "quotes": ["nothing happened at all"]}
        d.update(over)
        return CandidateDraft.model_validate(d)

    def test_accepts_evidence(self):
        v = validate_candidate(self.draft(), [self.s1], self.signals, self.names)
        assert v["ok"] and v["verifiedQuotes"][0]["stepId"] == self.s1["id"]

    def test_rejects_unknown_steps(self):
        assert not validate_candidate(self.draft(step_ids=["stp_made_up"]), [self.s1], self.signals, self.names)["ok"]

    def test_rejects_hallucinated_ui(self):
        v = validate_candidate(self.draft(element="Gift wrapping toggle"), [self.s1], self.signals, self.names)
        assert not v["ok"] and "does not appear" in " ".join(v["reasons"])

    def test_rejects_without_signal_or_quote(self):
        quiet = step(idx=2, thinkAloud="Looks fine.", obs={"domChanged": True, "networkCalls": 1})
        v = validate_candidate(self.draft(step_ids=[quiet["id"]], quotes=["the colours are ugly"]), [quiet], [], {quiet["id"]: ["Checkout"]})
        assert not v["ok"] and "no signal or verbatim quote" in " ".join(v["reasons"])

    def test_symbol_only_names(self):
        s = step(idx=9, obs={"domChanged": False}, target={"mark": 4, "selector": "span.close-x", "name": "×", "role": "generic", "box": {"x": 0, "y": 0, "width": 10, "height": 10}})
        d = CandidateDraft.model_validate({"title": "Close does nothing", "description": "", "page": "/", "element": "×", "heuristic": "user_control_and_freedom",
                                           "impact": "minor_friction", "step_ids": [s["id"]], "quotes": []})
        assert validate_candidate(d, [s], detect_signals([s], None), {s["id"]: ["×"]})["ok"]


class TestClustering:
    def mk(self, title, page, element):
        return {"title": title, "page": page, "element": element, "embedding": embed_text(f"{title} {page} {element}")}

    def test_groups_same_problem(self):
        items = [self.mk("Checkout button hidden behind cookie banner", "/bag", "Checkout"),
                 self.mk("Cookie banner covers the checkout button on mobile", "/bag", "Checkout"),
                 self.mk("Can't tap Checkout, banner in the way", "/bag", "Checkout"),
                 self.mk("Search returns no results for gift", "/search", "Search")]
        clusters = agglomerative(items)
        assert len(clusters) == 2 and any(len(c) == 3 for c in clusters)

    def test_embeddings_deterministic(self):
        a = embed_text("add to bag does nothing")
        assert cosine(a, embed_text("add to bag does nothing")) == pytest.approx(1, abs=1e-5)


class TestCheck:
    def snap(self, **over):
        return {"url": "http://x/a", "bodyText": "Bag (0)", "dialogOpen": False, "focused": None, "marked": {}, **over}

    def test_expectations(self):
        assert expectation_met({"type": "url_changes"}, self.snap(), self.snap(url="http://x/b")) is True
        assert expectation_met({"type": "text_appears", "value": "Bag (1)"}, self.snap(), self.snap()) is False
        m = {3: {"text": "Bag (0)", "html": "", "value": None}}
        assert expectation_met({"type": "text_changes", "mark": 3}, self.snap(marked=m), self.snap(marked=m)) is False
        assert expectation_met({"type": "dialog_opens"}, self.snap(), self.snap(dialogOpen=True)) is True
        assert expectation_met({"type": "none"}, self.snap(), self.snap()) is None

    def test_success_is_independent_of_the_agent(self):
        net = [{"stepId": None, "method": "POST", "url": "http://x/api/orders", "status": 201, "resourceType": "fetch", "startedAt": 0, "durationMs": 1, "failed": False}]
        crit = SuccessCriteria.model_validate({"mode": "any", "network": {"method": "POST", "url_pattern": "/api/orders", "status": 201}})
        assert check_success(crit, "http://x/", "", net)["success"]
        crit = SuccessCriteria.model_validate({"mode": "all", "url_pattern": "/order/", "text_present": "Order confirmed"})
        assert not check_success(crit, "http://x/order/KC1", "nope", [])["success"]
        assert not check_success(SuccessCriteria(), "", "", [])["success"]


class TestUtilities:
    def test_page_paths(self):
        assert page_path("http://x/products/12") == "/products/:id"
        assert page_path("http://x/order/KC123456") == "/order/:id"
        assert page_path("http://x/checkout?mode=guest") == "/checkout"

    def test_redaction(self):
        assert redact("mail sam@example.com or call +1 (555) 123-4567, card 4242 4242 4242 4242") == "mail [email] or call [phone], card [card]"
