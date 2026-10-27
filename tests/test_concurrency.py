from swarm.models import StudySpec
from swarm.store.db import Db

SPEC = StudySpec.model_validate({"name": "t", "target_url": "http://localhost:4400/", "allowed_domains": ["localhost"], "permission_confirmed": True,
                                 "tasks": [{"id": "a", "goal": "g", "success": {"url_pattern": "/x"}}], "personas": {"include": []}})


def test_one_runner_per_study():
    db = Db(":memory:")
    db.insert_study("s1", SPEC)
    assert db.acquire_study_lease("s1", "cli", 60_000)
    assert not db.acquire_study_lease("s1", "server", 60_000)
    assert db.acquire_study_lease("s1", "cli", 60_000)  # renewal
    assert db.acquire_study_lease("s1", "cli", -1)  # force expiry
    assert db.acquire_study_lease("s1", "server", 60_000)
    db.release_study_lease("s1", "server")
    assert db.study_lease("s1")["runner"] is None


def test_exactly_one_worker_claims_a_session():
    db = Db(":memory:")
    db.insert_study("s1", SPEC)
    db.insert_session({"id": "ses1", "studyId": "s1", "taskId": "a", "personaId": "p", "repetition": 0, "seed": 1})
    assert db.claim_session("ses1")
    assert not db.claim_session("ses1")
