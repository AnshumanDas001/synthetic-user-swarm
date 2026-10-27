"""LLM client over OpenRouter's OpenAI-compatible chat API: structured JSON outputs validated by Pydantic,
reasoning effort, refusal handling, prompt caching for the stable prefix, and exact per-call cost
(OpenRouter reports what each request was billed)."""
from __future__ import annotations

import base64
import contextvars
import copy
import json
import os
import re
from contextlib import contextmanager
from typing import Any, Iterator, Optional, Type, TypeVar

import httpx
from pydantic import BaseModel, ValidationError

from ..config import config

BASE = os.environ.get("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1")
T = TypeVar("T", bound=BaseModel)

# The API key for the work running in this context (a study on a user's own key), else the server's.
# asyncio tasks copy the context when created, so every task a study spawns inherits its key.
_key: contextvars.ContextVar[Optional[str]] = contextvars.ContextVar("openrouter_key", default=None)


@contextmanager
def with_api_key(api_key: Optional[str]) -> Iterator[None]:
    token = _key.set(api_key) if api_key else None
    try:
        yield
    finally:
        if token is not None:
            _key.reset(token)


class RefusalError(Exception):
    pass


class LlmHttpError(Exception):
    """Carries the HTTP status so callers can decide between retry, stop the study, or give up."""

    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


class SchemaError(Exception):
    """Raised after a call that was billed but returned unusable output, so the cost is still counted."""

    def __init__(self, message: str, usage: dict):
        super().__init__(message)
        self.usage = usage


def api_key() -> str:
    key = _key.get() or os.environ.get("OPENROUTER_API_KEY")
    if not key:
        raise LlmHttpError(401, "OPENROUTER_API_KEY is not set")
    return key


def _headers() -> dict:
    return {
        "authorization": f"Bearer {api_key()}",
        "content-type": "application/json",
        # Attribution headers OpenRouter shows in its dashboard.
        "HTTP-Referer": "https://github.com/synthetic-user-swarm",
        "X-Title": "Synthetic User Swarm",
    }


_http: Optional[httpx.AsyncClient] = None


def http() -> httpx.AsyncClient:
    global _http
    if _http is None or _http.is_closed:
        _http = httpx.AsyncClient(timeout=httpx.Timeout(180.0, connect=20.0))
    return _http


def image_block(jpeg: bytes) -> dict:
    return {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + base64.b64encode(jpeg).decode()}}


def text_block(text: str) -> dict:
    return {"type": "text", "text": text}


async def structured(*, model: str, schema: Type[T], system: str, content: list[dict], effort: str = "low",
                     max_tokens: int = 6000, name: str = "output") -> tuple[T, dict]:
    original = json_schema(schema)
    body = {
        "model": model,
        "max_tokens": max_tokens,
        "messages": [
            # The system prompt (persona card + instructions) repeats on every step: mark it cacheable.
            {"role": "system", "content": [{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}]},
            {"role": "user", "content": content},
        ],
        "response_format": {"type": "json_schema", "json_schema": {"name": name, "strict": True, "schema": to_strict_schema(original)}},
        "reasoning": {"effort": effort, "exclude": True},
        # Only route to providers that honour structured outputs; report the exact cost of each call.
        "provider": {"require_parameters": True},
        "usage": {"include": True},
    }
    try:
        res = await http().post(f"{BASE}/chat/completions", headers=_headers(), json=body)
    except httpx.HTTPError as e:
        raise LlmHttpError(0, f"network error: {e}") from e
    try:
        data = res.json()
    except ValueError:
        data = {}
    err = data.get("error") if isinstance(data, dict) else None
    if res.status_code >= 400 or err:
        code = (err or {}).get("code") or res.status_code
        raise LlmHttpError(int(code) if str(code).isdigit() else res.status_code, f"OpenRouter {code}: {(err or {}).get('message') or res.reason_phrase}")

    choices = data.get("choices") or []
    if not choices:
        raise LlmHttpError(502, "OpenRouter returned no choices")
    choice = choices[0]
    msg = choice.get("message") or {}
    if msg.get("refusal") or choice.get("finish_reason") == "content_filter" or choice.get("native_finish_reason") == "refusal":
        raise RefusalError(f"model refused: {msg.get('refusal') or choice.get('native_finish_reason') or choice.get('finish_reason')}")
    if choice.get("finish_reason") == "length":
        raise ValueError("structured output truncated at max_tokens")

    u = data.get("usage") or {}
    tin, tout = int(u.get("prompt_tokens") or 0), int(u.get("completion_tokens") or 0)
    cost = u.get("cost")
    usage = {"model": data.get("model") or model, "tokensIn": tin, "tokensOut": tout,
             "costUsd": float(cost) if cost is not None else await _estimate_cost(model, tin, tout)}
    try:
        value = schema.model_validate(strip_optional_nulls(parse_json(msg.get("content") or ""), original))
    except (ValidationError, ValueError) as e:
        raise SchemaError(f"output did not match the schema: {str(e)[:300]}", usage) from e
    return value, usage


def parse_json(text: str) -> Any:
    t = re.sub(r"```$", "", re.sub(r"^```(?:json)?\s*", "", text.strip(), flags=re.I))
    try:
        return json.loads(t)
    except ValueError:
        start, end = t.find("{"), t.rfind("}")
        if start >= 0 and end > start:
            return json.loads(t[start:end + 1])
        raise ValueError("model output was not JSON")


# ---------------------------------------------------------------- strict JSON schema

def json_schema(model: Type[BaseModel]) -> dict:
    """Pydantic's schema with every $ref inlined (strict mode on some providers rejects $defs)."""
    raw = model.model_json_schema(mode="validation")
    defs = raw.pop("$defs", {})

    def inline(node: Any) -> Any:
        if isinstance(node, list):
            return [inline(x) for x in node]
        if not isinstance(node, dict):
            return node
        if "$ref" in node:
            target = copy.deepcopy(defs[node["$ref"].split("/")[-1]])
            return inline({**target, **{k: v for k, v in node.items() if k != "$ref"}})
        return {k: inline(v) for k, v in node.items()}

    return inline(raw)


DROP = {"$schema", "title", "description", "discriminator", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum",
        "minLength", "maxLength", "pattern", "format", "default", "maxItems"}


def to_strict_schema(s: dict) -> dict:
    """Strict structured outputs need every property required and no extra properties. Optional fields become
    nullable (nulls are stripped before validation), range constraints are dropped (Pydantic still enforces
    them), and `const` becomes a one-value enum for wider provider support."""
    out = {k: v for k, v in s.items() if k not in DROP and not (k == "minItems" and isinstance(v, int) and v > 1)}
    if "const" in out:
        out["enum"] = [out.pop("const")]
        out.setdefault("type", "string")
    for key in ("anyOf", "oneOf", "allOf"):
        if isinstance(out.get(key), list):
            out[key] = [to_strict_schema(x) for x in out[key]]
    if "oneOf" in out:
        out["anyOf"] = out.pop("oneOf")
    if isinstance(out.get("items"), dict):
        out["items"] = to_strict_schema(out["items"])
    if out.get("type") == "object" and isinstance(out.get("properties"), dict):
        required = set(out.get("required") or [])
        nxt = {}
        for name, p in out["properties"].items():
            strict = to_strict_schema(p)
            nullable = any(b.get("type") == "null" for b in strict.get("anyOf", []))
            nxt[name] = strict if name in required or nullable else {"anyOf": [strict, {"type": "null"}]}
        out["properties"] = nxt
        out["required"] = list(nxt)
        out["additionalProperties"] = False
    return out


def strip_optional_nulls(v: Any, schema: Optional[dict]) -> Any:
    """Undo to_strict_schema's optional->nullable rewrite: drop a null only where the original schema had the
    property as optional. Genuinely nullable fields (required, null allowed) keep their null."""
    if not schema:
        return v
    if isinstance(v, list):
        return [strip_optional_nulls(x, schema.get("items")) for x in v]
    if not isinstance(v, dict):
        return v
    branches = [b for b in [schema, *(schema.get("anyOf") or schema.get("oneOf") or [])] if b.get("properties")]
    out = {}
    for k, x in v.items():
        branch = next((b for b in branches if k in b["properties"]), None)
        optional = branch is not None and k not in (branch.get("required") or [])
        if x is None and optional:
            continue
        out[k] = strip_optional_nulls(x, branch["properties"][k] if branch else None)
    return out


# ---------------------------------------------------------------- pricing, credits, preflight

_catalogue: Optional[dict[str, dict]] = None


async def model_catalogue() -> dict[str, dict]:
    global _catalogue
    if _catalogue is not None:
        return _catalogue
    res = await http().get(f"{BASE}/models", timeout=30)
    _catalogue = {
        m["id"]: {
            "in": float(m["pricing"]["prompt"]) * 1e6,
            "out": float(m["pricing"]["completion"]) * 1e6,
            "vision": "image" in ((m.get("architecture") or {}).get("input_modalities") or []),
            "structured": "structured_outputs" in (m.get("supported_parameters") or []),
        }
        for m in res.json()["data"]
    }
    return _catalogue


async def _estimate_cost(model: str, tin: int, tout: int) -> float:
    """Fallback when a response carries no cost: list price x tokens."""
    try:
        p = (await model_catalogue()).get(model)
    except Exception:
        p = None
    return (tin * p["in"] + tout * p["out"]) / 1e6 if p else 0.0


async def credits_remaining() -> dict:
    """Credit left on this key (OpenRouter key limit, or account credits when the key has no limit)."""
    res = await http().get(f"{BASE}/key", headers=_headers(), timeout=20)
    if res.status_code in (401, 403):
        raise LlmHttpError(res.status_code, "OpenRouter rejected the API key")
    d = res.json()["data"]
    if d.get("limit_remaining") is not None:
        return {"remainingUsd": d["limit_remaining"], "usedUsd": d["usage"], "limitUsd": d["limit"]}
    try:
        c = (await http().get(f"{BASE}/credits", headers=_headers(), timeout=20)).json().get("data")
    except Exception:
        c = None
    if c:
        return {"remainingUsd": c["total_credits"] - c["total_usage"], "usedUsd": c["total_usage"], "limitUsd": c["total_credits"]}
    return {"remainingUsd": None, "usedUsd": d["usage"], "limitUsd": d.get("limit")}


async def preflight(models: list[str]) -> dict:
    """Fail fast before launching a swarm: the key works, the models exist and can see images and return
    structured JSON. Returns the credit left so the study cap can be clamped to it."""
    try:
        credits = await credits_remaining()
    except LlmHttpError as e:
        raise RuntimeError(f"{e}. Set a valid OPENROUTER_API_KEY in .env, or run offline with SWARM_MODEL_MODE=mock.") from e
    rem = credits["remainingUsd"]
    if rem is not None and rem <= config.credit_reserve_usd:
        raise RuntimeError(f"only ${rem:.2f} of OpenRouter credit left (reserve is ${config.credit_reserve_usd}); top up or lower SWARM_CREDIT_RESERVE_USD")
    cat = await model_catalogue()
    for m in set(models):
        info = cat.get(m)
        if not info:
            raise RuntimeError(f"model {m} is not on OpenRouter (check the id at https://openrouter.ai/models)")
        if not info["structured"]:
            raise RuntimeError(f"model {m} does not support structured outputs on OpenRouter")
    if not (cat.get(config.models.step) or {}).get("vision"):
        raise RuntimeError(f"step model {config.models.step} cannot read images")
    return credits


def is_fatal(err: BaseException) -> bool:
    """Credentials, permissions or credit are wrong: no retry will help, so the study stops."""
    return isinstance(err, LlmHttpError) and err.status in (401, 402, 403)


def is_retryable(err: BaseException) -> bool:
    return isinstance(err, LlmHttpError) and (err.status in (0, 408, 429) or err.status >= 500)
