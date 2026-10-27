"""OpenRouter client against a faked HTTP layer: no network, no credit spent."""
import asyncio
import json
import os
from typing import Optional

import httpx
import pytest
from pydantic import BaseModel

from swarm.llm import client
from swarm.llm.client import (LlmHttpError, RefusalError, SchemaError, is_fatal, is_retryable, json_schema, strip_optional_nulls, structured,
                              text_block, to_strict_schema)
from swarm.models import AgentStep

os.environ["OPENROUTER_API_KEY"] = "sk-or-test"


def fake(status: int, body: dict) -> list:
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append({"url": str(request.url), "body": json.loads(request.content)})
        return httpx.Response(status, json=body)

    client._http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    return calls


def ok(content, **extra):
    choice = {"finish_reason": "stop", "message": {"content": content}, **extra}
    return {"model": "anthropic/claude-haiku-5.5", "choices": [choice], "usage": {"prompt_tokens": 3600, "completion_tokens": 420, "cost": 0.00057}}


def call():
    return structured(model="anthropic/claude-haiku-5.5", schema=AgentStep, system="persona", content=[text_block("hi")], effort="low")


STEP = {"think_aloud": "Where is checkout?", "confidence": 2, "frustration": 1, "action": {"type": "click", "mark": 4},
        "expectation": {"says": "Bag opens", "check": {"type": "url_changes"}}, "note": None}


class TestStrictSchema:
    schema = to_strict_schema(json_schema(AgentStep))

    def test_every_property_required_no_extras(self):
        assert self.schema["additionalProperties"] is False
        assert sorted(self.schema["required"]) == ["action", "confidence", "expectation", "frustration", "note", "think_aloud"]
        assert self.schema["properties"]["expectation"]["additionalProperties"] is False

    def test_optional_becomes_nullable(self):
        assert self.schema["properties"]["note"]["anyOf"] == [{"type": "string"}, {"type": "null"}]

    def test_union_as_anyof_with_enum_discriminators(self):
        branches = self.schema["properties"]["action"]["anyOf"]
        assert len(branches) > 8 and branches[0]["properties"]["type"]["enum"] == ["click"]
        s = json.dumps(self.schema)
        for word in ('"minimum"', '"maximum"', '"const"', '"oneOf"', '"$schema"', '"$ref"', '"$defs"'):
            assert word not in s

    def test_keeps_nulls_on_nullable_and_drops_them_on_optional(self):
        class M(BaseModel):
            defect: Optional[str]
            note: Optional[str] = None

        class S(BaseModel):
            matches: list[M]

        out = strip_optional_nulls({"matches": [{"defect": None, "note": None}, {"defect": "D04", "note": "x"}]}, json_schema(S))
        assert out == {"matches": [{"defect": None}, {"defect": "D04", "note": "x"}]}
        S.model_validate(out)


class TestStructured:
    def test_request_shape_and_exact_cost(self):
        calls = fake(200, ok(json.dumps(STEP)))
        value, usage = asyncio.run(call())
        assert value.action.model_dump(exclude_none=True) == {"type": "click", "mark": 4}
        assert value.note is None
        assert usage == {"model": "anthropic/claude-haiku-5.5", "tokensIn": 3600, "tokensOut": 420, "costUsd": 0.00057}
        b = calls[0]["body"]
        assert calls[0]["url"].endswith("/chat/completions")
        assert b["response_format"]["type"] == "json_schema" and b["response_format"]["json_schema"]["strict"] is True
        assert b["provider"]["require_parameters"] is True and b["reasoning"]["effort"] == "low" and b["usage"]["include"] is True
        assert b["messages"][0]["content"][0]["cache_control"] == {"type": "ephemeral"}

    def test_fenced_json(self):
        fake(200, ok("```json\n" + json.dumps({**STEP, "action": {"type": "back"}}) + "\n```"))
        assert asyncio.run(call())[0].action.type == "back"

    def test_schema_error_carries_cost(self):
        fake(200, ok(json.dumps({**STEP, "action": {"type": "teleport"}})))
        with pytest.raises(SchemaError) as e:
            asyncio.run(call())
        assert e.value.usage["costUsd"] == 0.00057

    def test_refusal_credit_and_rate_limits(self):
        fake(200, ok("", message={"content": None, "refusal": "I can't help with that"}))
        with pytest.raises(RefusalError):
            asyncio.run(call())
        fake(402, {"error": {"code": 402, "message": "Insufficient credits"}})
        with pytest.raises(LlmHttpError) as e402:
            asyncio.run(call())
        assert is_fatal(e402.value)
        fake(429, {"error": {"code": 429, "message": "rate limited"}})
        with pytest.raises(LlmHttpError) as e429:
            asyncio.run(call())
        assert is_retryable(e429.value) and not is_fatal(e429.value)

    def test_per_run_key_context(self):
        seen = []

        def handler(request):
            seen.append(request.headers["authorization"])
            return httpx.Response(200, json=ok(json.dumps(STEP)))

        client._http = httpx.AsyncClient(transport=httpx.MockTransport(handler))

        async def two():
            with client.with_api_key("sk-or-user-key"):
                await call()
            await call()

        asyncio.run(two())
        assert seen == ["Bearer sk-or-user-key", "Bearer sk-or-test"]
