"""Hosted mode: SSRF guard, key encryption, Google ID-token verification, free-run accounting, and the API's
per-user scoping and launch policy."""
import asyncio
import hashlib
import json
import time

import httpx
import pytest
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from fastapi.testclient import TestClient

from swarm import crypto
from swarm.config import config
from swarm.crypto import b64url
from swarm.runtime import netguard
from swarm.server import google
from swarm.store.accounts import create_account_store

CLIENT_ID = "test-client.apps.googleusercontent.com"


@pytest.fixture
def hosted(monkeypatch):
    monkeypatch.setattr(config, "google_client_id", CLIENT_ID)
    monkeypatch.setattr(config, "google_client_secret", "x")


class TestNetguard:
    def test_classifies_private_addresses(self):
        for ip in ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "0.0.0.0", "100.64.0.1", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1"]:
            assert netguard.is_private_address(ip), ip
        for ip in ["8.8.8.8", "104.21.3.4", "2606:4700::1111"]:
            assert not netguard.is_private_address(ip), ip

    def test_refuses_non_http_and_private_hosts(self, hosted):
        async def go():
            for url in ["file:///etc/passwd", "http://127.0.0.1:4300/api/studies", "http://169.254.169.254/latest/meta-data/", "http://localhost:4300/", "http://[::1]/"]:
                assert not await netguard.url_is_safe(url), url
            with pytest.raises(ValueError, match="public http"):
                await netguard.assert_url_safe("http://10.0.0.5/", "target_url")
        asyncio.run(go())


def test_api_key_encryption_round_trip_and_tamper():
    enc = crypto.encrypt("sk-or-v1-abc123")
    assert "abc123" not in enc and crypto.decrypt(enc) == "sk-or-v1-abc123"
    parts = enc.split(".")
    parts[3] = b64url(b"tampered")
    with pytest.raises(Exception):
        crypto.decrypt(".".join(parts))


class TestGoogleIdToken:
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    nums = key.public_key().public_numbers()
    jwk = {"kty": "RSA", "kid": "k1", "alg": "RS256", "use": "sig",
           "n": b64url(nums.n.to_bytes((nums.n.bit_length() + 7) // 8, "big")), "e": b64url(nums.e.to_bytes(3, "big"))}

    def sign(self, claims, kid="k1"):
        h = b64url(json.dumps({"alg": "RS256", "kid": kid, "typ": "JWT"}).encode())
        p = b64url(json.dumps(claims).encode())
        return f"{h}.{p}.{b64url(self.key.sign(f'{h}.{p}'.encode(), padding.PKCS1v15(), hashes.SHA256()))}"

    def good(self, **over):
        return {"iss": "https://accounts.google.com", "aud": CLIENT_ID, "sub": "123", "email": "a@b.com", "email_verified": True,
                "exp": int(time.time()) + 300, "nonce": "n1", **over}

    @pytest.fixture(autouse=True)
    def jwks(self, hosted, monkeypatch):
        monkeypatch.setattr(google, "_jwks", {"keys": [self.jwk], "at": time.time()})

    def test_accepts_correct_token(self):
        assert asyncio.run(google.verify_id_token(self.sign(self.good())))["sub"] == "123"

    def test_rejects_forged_wrong_app_wrong_issuer_expired(self):
        forged = self.sign(self.good()).split(".")
        forged[1] = b64url(json.dumps(self.good(sub="attacker")).encode())
        cases = [(".".join(forged), "signature"), (self.sign(self.good(aud="other-app")), "not issued for this app"),
                 (self.sign(self.good(iss="https://evil.example")), "issuer"), (self.sign(self.good(exp=int(time.time()) - 3600)), "expired")]
        for token, msg in cases:
            with pytest.raises(google.SignInError, match=msg):
                asyncio.run(google.verify_id_token(token))

    def test_pkce_authorization_url(self):
        verifier, challenge = google.pkce_pair()
        assert b64url(hashlib.sha256(verifier.encode()).digest()) == challenge
        url = httpx.URL(google.auth_url("https://swarm.example", "s", "n", challenge))
        assert url.params["redirect_uri"] == "https://swarm.example/auth/google/callback"
        assert url.params["code_challenge_method"] == "S256" and url.params["scope"] == "openid email profile"


def test_free_run_accounting_is_atomic(tmp_path):
    async def go():
        store = create_account_store(str(tmp_path / "accounts.db"))
        await store.init()
        u = await store.upsert_google_user("g-1", "x@y.com", "X", None)
        results = await asyncio.gather(*(store.consume_free_run(u["id"], 1) for _ in range(3)))
        assert sum(results) == 1
        await store.refund_free_run(u["id"])
        assert await store.consume_free_run(u["id"], 1)
        await store.add_platform_spend("2026-10-27", 0.04)
        await store.add_platform_spend("2026-10-27", 0.03)
        assert await store.platform_spend("2026-10-27") == pytest.approx(0.07)
        await store.close()
    asyncio.run(go())


class TestHostedApi:
    """Two Google users against the real FastAPI app: each sees only their own studies, and the launch policy holds."""

    @pytest.fixture
    def api(self, hosted, data_dir, monkeypatch):
        from swarm.server import app as app_module
        from swarm.server.auth import _sign
        from swarm.orchestrator import BrowserPool

        async def no_warm(self):
            return None
        monkeypatch.setattr(BrowserPool, "warm", no_warm)
        app = app_module.create_app()
        with TestClient(app) as c:
            store = create_account_store()

            async def users():
                await store.init()
                return await store.upsert_google_user("g-alice", "alice@example.com", "Alice", None), await store.upsert_google_user("g-bob", "bob@example.com", "Bob", None)
            alice, bob = asyncio.run(users())
            exp = int(time.time() * 1000) + 3600_000
            cookie = lambda u: {"swarm_session": _sign(u["id"], exp)}  # noqa: E731
            yield c, store, alice, bob, cookie

    def spec(self, n_personas=2, url="https://example.com/"):
        ids = ["priya-power-user", "asha-68-mobile", "ravi-keyboard", "tom-impatient", "mei-non-native", "sam-screen-reader", "fatima-busy-parent"][:n_personas]
        return {"name": "t", "target_url": url, "allowed_domains": ["example.com"], "permission_confirmed": True,
                "tasks": [{"id": "a", "goal": "g", "success": {"url_pattern": "/x"}}], "personas": {"include": ids}, "budget": {"repetitions": 1}}

    def test_signed_out_is_refused(self, api):
        c, *_ = api
        assert c.get("/api/studies").status_code == 401
        r = c.get("/", follow_redirects=False)
        assert r.status_code == 302 and r.headers["location"].startswith("/login")
        assert "Sign in with Google" in c.get("/login").text

    def test_users_only_see_their_own_studies(self, api):
        c, store, alice, bob, cookie = api
        from swarm.models import StudySpec
        from swarm.store.db import Db
        db = Db()
        db.insert_study("study_aaaaaaaaaaaa", StudySpec.model_validate(self.spec()), owner_id=alice["id"])
        assert [s["id"] for s in c.get("/api/studies", cookies=cookie(alice)).json()] == ["study_aaaaaaaaaaaa"]
        assert c.get("/api/studies", cookies=cookie(bob)).json() == []
        for path in ["/api/studies/study_aaaaaaaaaaaa", "/api/studies/study_aaaaaaaaaaaa/events", "/blobs/study_aaaaaaaaaaaa/x.jpg",
                     "/reports/study_aaaaaaaaaaaa/v1/index.html", "/replay/study_aaaaaaaaaaaa/step/stp_1"]:
            assert c.get(path, cookies=cookie(bob)).status_code == 404, path
        assert c.get("/api/studies/study_aaaaaaaaaaaa", cookies=cookie(alice)).json()["study"]["ownerId"] == alice["id"]

    def test_free_run_limits_and_needs_key(self, api):
        c, store, alice, bob, cookie = api
        me = c.get("/api/me", cookies=cookie(alice)).json()
        assert me["freeRunsLeft"] == 1 and me["hasKey"] is False and me["mode"] == "google"
        # Too big for the free run.
        r = c.post("/api/studies", json=self.spec(7), cookies=cookie(alice))
        assert r.status_code == 400 and r.json()["code"] == "free_limit"
        # A private target is refused at plan time, and the free run is refunded.
        r = c.post("/api/studies", json={**self.spec(2, "http://127.0.0.1:9/"), "allowed_domains": ["127.0.0.1"]}, cookies=cookie(alice))
        assert r.status_code == 400 and "public http" in r.json()["error"]
        assert c.get("/api/me", cookies=cookie(alice)).json()["freeRunsLeft"] == 1
        # Once the free run is used, launching needs the user's own key.
        asyncio.run(store.consume_free_run(alice["id"], 1))
        r = c.post("/api/studies", json=self.spec(2), cookies=cookie(alice))
        assert r.status_code == 402 and r.json()["code"] == "needs_key"
        # A key that is obviously not an OpenRouter key is rejected before any network call.
        assert c.post("/api/account/key", json={"key": "hello"}, cookies=cookie(alice)).status_code == 400

    def test_config_hides_admin_fields(self, api):
        c, _, alice, _, cookie = api
        cfg = c.get("/api/config", cookies=cookie(alice)).json()
        assert cfg["authMode"] == "google" and cfg["admin"] is False and "dataDir" not in cfg and cfg["limits"]["freeMaxSessions"] == 6
