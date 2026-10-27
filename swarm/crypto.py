"""Server secret, signed tokens and at-rest encryption for user API keys (AES-256-GCM)."""
from __future__ import annotations

import base64
import hashlib
import hmac as _hmac
import os
import secrets

from cryptography.hazmat.primitives.ciphers.aead import AESGCM


def server_secret() -> str:
    s = os.environ.get("SWARM_SECRET") or os.environ.get("SWARM_PASSWORD")
    if not s:
        raise RuntimeError("SWARM_SECRET is required for sign-in and key storage (any long random string)")
    return s


def _key(purpose: str) -> bytes:
    return hashlib.sha256(f"{purpose}:{server_secret()}".encode()).digest()


def b64url(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def b64url_decode(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def hmac(purpose: str, data: str) -> str:
    return b64url(_hmac.new(_key(purpose), data.encode(), hashlib.sha256).digest())


def safe_equal(a: str, b: str) -> bool:
    return _hmac.compare_digest(a.encode(), b.encode())


def encrypt(plain: str) -> str:
    iv = secrets.token_bytes(12)
    ct = AESGCM(_key("api-keys")).encrypt(iv, plain.encode(), None)
    body, tag = ct[:-16], ct[-16:]
    return f"v1.{b64url(iv)}.{b64url(tag)}.{b64url(body)}"


def decrypt(token: str) -> str:
    v, iv, tag, body = token.split(".")
    if v != "v1":
        raise ValueError("unknown key format")
    return AESGCM(_key("api-keys")).decrypt(b64url_decode(iv), b64url_decode(body) + b64url_decode(tag), None).decode()


def random_token(n: int = 24) -> str:
    return secrets.token_urlsafe(n)
