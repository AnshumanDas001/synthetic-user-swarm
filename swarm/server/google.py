"""Sign in with Google: OpenID Connect authorization-code flow with PKCE, state and nonce. The ID token's RS256
signature is verified against Google's published keys (JWKS), then its claims."""
from __future__ import annotations

import hashlib
import json
import secrets
import time
from typing import Optional
from urllib.parse import urlencode

import httpx
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding, rsa

from ..config import config
from ..crypto import b64url, b64url_decode

AUTH = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN = "https://oauth2.googleapis.com/token"
JWKS = "https://www.googleapis.com/oauth2/v3/certs"
ISSUERS = ("https://accounts.google.com", "accounts.google.com")


class SignInError(Exception):
    pass


def redirect_uri(origin: str) -> str:
    return f"{config.public_url or origin}/auth/google/callback"


def pkce_pair() -> tuple[str, str]:
    verifier = b64url(secrets.token_bytes(32))
    return verifier, b64url(hashlib.sha256(verifier.encode()).digest())


def auth_url(origin: str, state: str, nonce: str, challenge: str) -> str:
    return AUTH + "?" + urlencode({
        "client_id": config.google_client_id, "redirect_uri": redirect_uri(origin), "response_type": "code",
        "scope": "openid email profile", "state": state, "nonce": nonce, "code_challenge": challenge,
        "code_challenge_method": "S256", "prompt": "select_account",
    })


async def exchange_code(origin: str, code: str, verifier: str, nonce: str) -> dict:
    """Returns the identity {sub, email, name, picture}."""
    async with httpx.AsyncClient(timeout=15) as c:
        res = await c.post(TOKEN, data={
            "code": code, "client_id": config.google_client_id, "client_secret": config.google_client_secret,
            "redirect_uri": redirect_uri(origin), "grant_type": "authorization_code", "code_verifier": verifier,
        })
    j = res.json() if res.content else {}
    if res.status_code >= 400 or not j.get("id_token"):
        raise SignInError(f"Google sign-in failed: {j.get('error_description') or j.get('error') or res.status_code}")
    claims = await verify_id_token(j["id_token"])
    if claims.get("nonce") != nonce:
        raise SignInError("Google sign-in failed: nonce mismatch")
    if not claims.get("email") or claims.get("email_verified") is not True:
        raise SignInError("Google sign-in failed: the account's email is not verified")
    return {"sub": str(claims["sub"]), "email": str(claims["email"]), "name": str(claims.get("name") or claims["email"]), "picture": claims.get("picture")}


_jwks: Optional[dict] = None


async def _key_for(kid: str) -> rsa.RSAPublicKey:
    global _jwks
    if not _jwks or time.time() - _jwks["at"] > 3600 or not any(k["kid"] == kid for k in _jwks["keys"]):
        async with httpx.AsyncClient(timeout=10) as c:
            _jwks = {"keys": (await c.get(JWKS)).json()["keys"], "at": time.time()}
    jwk = next((k for k in _jwks["keys"] if k["kid"] == kid), None)
    if not jwk:
        raise SignInError("Google sign-in failed: unknown signing key")
    n = int.from_bytes(b64url_decode(jwk["n"]), "big")
    e = int.from_bytes(b64url_decode(jwk["e"]), "big")
    return rsa.RSAPublicNumbers(e, n).public_key()


async def verify_id_token(token: str) -> dict:
    parts = token.split(".")
    if len(parts) != 3 or not all(parts):
        raise SignInError("Google sign-in failed: malformed token")
    h, p, s = parts
    header = json.loads(b64url_decode(h))
    if header.get("alg") != "RS256":
        raise SignInError("Google sign-in failed: unexpected token algorithm")
    key = await _key_for(header.get("kid", ""))
    try:
        key.verify(b64url_decode(s), f"{h}.{p}".encode(), padding.PKCS1v15(), hashes.SHA256())
    except InvalidSignature as e:
        raise SignInError("Google sign-in failed: bad token signature") from e
    claims = json.loads(b64url_decode(p))
    if str(claims.get("iss")) not in ISSUERS:
        raise SignInError("Google sign-in failed: wrong issuer")
    if claims.get("aud") != config.google_client_id:
        raise SignInError("Google sign-in failed: token not issued for this app")
    if float(claims.get("exp", 0)) < time.time() - 60:
        raise SignInError("Google sign-in failed: token expired")
    return claims
