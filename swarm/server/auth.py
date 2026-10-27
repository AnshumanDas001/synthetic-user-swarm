"""Access control. Three modes:
 - google:   GOOGLE_CLIENT_ID set. People sign in with Google; each sees only their own studies.
             SWARM_PASSWORD (optional) adds an admin sign-in; SWARM_ADMIN_EMAILS marks Google admins.
 - password: only SWARM_PASSWORD set. One admin login.
 - local:    neither set. No login; the server only listens on localhost.
Sessions are signed, HTTP-only cookies; scripts may use "Authorization: Bearer <SWARM_PASSWORD>" (admin)."""
from __future__ import annotations

import os
import re
import time
from typing import Optional
from urllib.parse import quote

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse, Response

from ..config import config, multi_user
from ..crypto import b64url, b64url_decode, hmac, random_token, safe_equal
from ..store.accounts import AccountStore
from ..util import log
from .google import SignInError, auth_url, exchange_code, pkce_pair
from .login_page import login_html

COOKIE = "swarm_session"
OAUTH_COOKIE = "swarm_oauth"
TTL_S = 7 * 24 * 3600
# Reachable without signing in.
OPEN_PATHS = {"/login", "/auth/google", "/auth/google/callback", "/api/login", "/api/logout", "/healthz"}

ADMIN = {"id": "admin", "sub": "admin", "email": "admin", "name": "Admin", "picture": None, "role": "admin", "freeRunsUsed": 0,
         "apiKeyEnc": None, "apiKeyLast4": None, "createdAt": 0}
LOCAL = {**ADMIN, "id": "local", "sub": "local", "email": "local", "name": "You"}


def auth_mode() -> str:
    return "google" if multi_user() else "password" if os.environ.get("SWARM_PASSWORD") else "local"


def auth_enabled() -> bool:
    return auth_mode() != "local"


def current_user(request: Request) -> dict:
    return request.state.user


def _sign(user_id: str, exp: int) -> str:
    return f"v2.{user_id}.{exp}.{hmac('session', f'{user_id}.{exp}')}"


def _read_session(token: Optional[str]) -> Optional[str]:
    if not token:
        return None
    parts = token.split(".")
    if len(parts) != 4:
        return None
    v, user_id, exp, mac = parts
    if v != "v2" or not user_id or not exp.isdigit() or int(exp) < time.time() * 1000:
        return None
    return user_id if safe_equal(mac, hmac("session", f"{user_id}.{exp}")) else None


def _secure(request: Request) -> bool:
    return request.url.scheme == "https" or request.headers.get("x-forwarded-proto") == "https" or config.public_url.startswith("https://")


def _origin(request: Request) -> str:
    return f"{'https' if _secure(request) else 'http'}://{request.headers.get('host')}"


def _set_cookie(response: Response, request: Request, name: str, value: str, max_age: int) -> None:
    response.set_cookie(name, value, max_age=max_age, path="/", httponly=True, samesite="lax", secure=_secure(request))


def _password_matches(given: str) -> bool:
    pw = os.environ.get("SWARM_PASSWORD")
    return bool(pw) and safe_equal(hmac("pw", given), hmac("pw", pw))


def _safe_next(n: Optional[str]) -> str:
    return n if isinstance(n, str) and n.startswith("/") and not n.startswith("//") else "/"


def install_auth(app: FastAPI, accounts: AccountStore) -> None:
    mode = auth_mode()
    attempts: dict[str, dict] = {}

    @app.get("/login", include_in_schema=False)
    async def login(error: str = ""):
        if mode == "local":
            return RedirectResponse("/")
        return HTMLResponse(login_html(mode, error))

    # ---------------- Google
    @app.get("/auth/google", include_in_schema=False)
    async def google_start(request: Request, next: str = "/"):
        if mode != "google":
            return RedirectResponse("/login")
        state, nonce = random_token(18), random_token(18)
        verifier, challenge = pkce_pair()
        payload = ".".join(b64url(x.encode()) for x in (state, nonce, verifier, _safe_next(next)))
        res = RedirectResponse(auth_url(_origin(request), state, nonce, challenge), status_code=302)
        _set_cookie(res, request, OAUTH_COOKIE, f"{payload}.{hmac('oauth', payload)}", 600)
        return res

    @app.get("/auth/google/callback", include_in_schema=False)
    async def google_callback(request: Request):
        def fail(msg: str) -> RedirectResponse:
            return RedirectResponse(f"/login?error={quote(msg)}", status_code=302)

        q = request.query_params
        try:
            if q.get("error"):
                return fail("Sign-in was cancelled." if q["error"] == "access_denied" else f"Google returned: {q['error']}")
            parts = (request.cookies.get(OAUTH_COOKIE) or "").split(".")
            mac = parts.pop() if parts else ""
            payload = ".".join(parts)
            if not payload or len(parts) != 4 or not safe_equal(mac, hmac("oauth", payload)):
                return fail("Sign-in expired. Please try again.")
            state, nonce, verifier, nxt = (b64url_decode(x).decode() for x in parts)
            if not safe_equal(q.get("state", ""), state):
                return fail("Sign-in could not be verified. Please try again.")
            identity = await exchange_code(_origin(request), q.get("code", ""), verifier, nonce)
            user = await accounts.upsert_google_user(**identity)
            res = RedirectResponse(_safe_next(nxt), status_code=302)
            res.delete_cookie(OAUTH_COOKIE, path="/")
            _set_cookie(res, request, COOKIE, _sign(user["id"], int(time.time() * 1000) + TTL_S * 1000), TTL_S)
            log("auth", f"signed in {user['email']} ({user['role']})")
            return res
        except SignInError as e:
            return fail(str(e))
        except Exception as e:  # network trouble talking to Google
            return fail(f"Google sign-in failed: {e}")

    # ---------------- password (admin)
    @app.post("/api/login", include_in_schema=False)
    async def password_login(request: Request):
        ip = request.client.host if request.client else "?"
        a = attempts.get(ip)
        if a and a["n"] >= 5 and a["until"] > time.time():
            return JSONResponse({"error": "Too many attempts; try again in a minute."}, status_code=429)
        try:
            body = await request.json()
        except Exception:
            body = {}
        if not _password_matches(str((body or {}).get("password") or "")):
            attempts[ip] = {"n": (a or {"n": 0})["n"] + 1, "until": time.time() + 60}
            return JSONResponse({"error": "Wrong password."}, status_code=401)
        attempts.pop(ip, None)
        res = JSONResponse({"ok": True})
        _set_cookie(res, request, COOKIE, _sign("admin", int(time.time() * 1000) + TTL_S * 1000), TTL_S)
        return res

    @app.post("/api/logout", include_in_schema=False)
    async def logout(request: Request):
        res = JSONResponse({"ok": True})
        _set_cookie(res, request, COOKIE, "", 0)
        return res

    # ---------------- gate
    @app.middleware("http")
    async def gate(request: Request, call_next):
        if mode == "local":
            request.state.user = LOCAL
            return await call_next(request)
        if request.url.path in OPEN_PATHS:
            return await call_next(request)
        m = re.match(r"^Bearer (.+)$", request.headers.get("authorization", ""))
        user = None
        if m and _password_matches(m.group(1)):
            user = ADMIN
        else:
            uid = _read_session(request.cookies.get(COOKIE))
            if uid == "admin" and os.environ.get("SWARM_PASSWORD"):
                user = ADMIN
            elif uid and mode == "google":
                try:
                    user = await accounts.get_user(uid)
                except Exception:
                    user = None
        if user:
            request.state.user = user
            return await call_next(request)
        if request.url.path.startswith(("/api/", "/blobs/")):
            return JSONResponse({"error": "Sign in required."}, status_code=401)
        target = request.url.path + (f"?{request.url.query}" if request.url.query else "")
        return RedirectResponse(f"/login?next={quote(target)}", status_code=302)
