// OpenRouter client against a faked HTTP layer: no network, no credit spent.
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AgentAction, ExpectationCheck } from "../src/types.js";
import { isFatal, isRetryable, LlmHttpError, RefusalError, SchemaError, stripNulls, stripOptionalNulls, structured, textBlock, toStrictSchema } from "../src/llm/client.js";

process.env.OPENROUTER_API_KEY = "sk-or-test";

const Step = z.object({
  think_aloud: z.string(),
  confidence: z.number(),
  action: AgentAction,
  expectation: z.object({ says: z.string(), check: ExpectationCheck }),
  note: z.string().optional(),
});

function fakeFetch(status: number, body: unknown) {
  const calls: { url: string; body: any }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }));
  return calls;
}

const ok = (content: string, extra: Record<string, unknown> = {}) => ({
  model: "anthropic/claude-haiku-5.5",
  choices: [{ finish_reason: "stop", message: { content }, ...extra }],
  usage: { prompt_tokens: 3600, completion_tokens: 420, cost: 0.00057 },
});

afterEach(() => vi.unstubAllGlobals());

describe("strict JSON schema for structured outputs", () => {
  const schema = toStrictSchema(z.toJSONSchema(Step, { io: "output", reused: "inline" }) as Record<string, unknown>) as any;

  it("requires every property and forbids extras at every level", () => {
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required.sort()).toEqual(["action", "confidence", "expectation", "note", "think_aloud"]);
    expect(schema.properties.expectation.additionalProperties).toBe(false);
  });
  it("turns optional fields into nullable ones", () => {
    expect(schema.properties.note.anyOf).toEqual([{ type: "string" }, { type: "null" }]);
  });
  it("expresses the action union as anyOf with enum discriminators and no range keywords", () => {
    const branches = schema.properties.action.anyOf;
    expect(branches.length).toBeGreaterThan(8);
    expect(branches[0].properties.type.enum).toEqual(["click"]);
    expect(JSON.stringify(schema)).not.toMatch(/"minimum"|"maximum"|"const"|"oneOf"|"\$schema"/);
  });
  it("keeps nulls on genuinely nullable fields and drops them on optional ones", () => {
    const S = z.object({ matches: z.array(z.object({ defect: z.string().nullable(), note: z.string().optional() })) });
    const original = z.toJSONSchema(S, { io: "output", reused: "inline" }) as Record<string, unknown>;
    const out = stripOptionalNulls({ matches: [{ defect: null, note: null }, { defect: "D04", note: "x" }] }, original);
    expect(out).toEqual({ matches: [{ defect: null }, { defect: "D04", note: "x" }] });
    expect(S.safeParse(out).success).toBe(true);
  });
  it("strips nulls before zod validation", () => {
    expect(stripNulls({ a: 1, note: null, b: [{ c: null, d: 2 }] })).toEqual({ a: 1, b: [{ d: 2 }] });
  });
});

describe("structured() over OpenRouter", () => {
  const call = { model: "anthropic/claude-haiku-5.5", schema: Step, system: "persona", content: [textBlock("hi")], effort: "low" as const };

  it("sends a strict json_schema request, routes only to compatible providers and reports exact cost", async () => {
    const calls = fakeFetch(200, ok(JSON.stringify({ think_aloud: "Where is checkout?", confidence: 2, action: { type: "click", mark: 4 }, expectation: { says: "Bag opens", check: { type: "url_changes" } }, note: null })));
    const { value, usage } = await structured(call);
    expect(value.action).toEqual({ type: "click", mark: 4 });
    expect(value.note).toBeUndefined();
    expect(usage).toEqual({ model: "anthropic/claude-haiku-5.5", tokensIn: 3600, tokensOut: 420, costUsd: 0.00057 });
    const b = calls[0].body;
    expect(calls[0].url).toMatch(/\/chat\/completions$/);
    expect(b.response_format.type).toBe("json_schema");
    expect(b.response_format.json_schema.strict).toBe(true);
    expect(b.provider.require_parameters).toBe(true);
    expect(b.reasoning.effort).toBe("low");
    expect(b.usage.include).toBe(true);
    expect(b.messages[0].content[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("tolerates a fenced JSON reply", async () => {
    fakeFetch(200, ok("```json\n" + JSON.stringify({ think_aloud: "x", confidence: 3, action: { type: "back" }, expectation: { says: "y", check: { type: "none" } } }) + "\n```"));
    expect((await structured(call)).value.action.type).toBe("back");
  });

  it("raises SchemaError carrying the billed cost when output does not validate", async () => {
    fakeFetch(200, ok(JSON.stringify({ think_aloud: "x", confidence: 3, action: { type: "teleport" }, expectation: { says: "y", check: { type: "none" } } })));
    const err = await structured(call).catch((e) => e);
    expect(err).toBeInstanceOf(SchemaError);
    expect(err.usage.costUsd).toBe(0.00057);
  });

  it("maps refusals, out-of-credit and rate limits to the right handling", async () => {
    fakeFetch(200, ok("", { message: { content: null, refusal: "I can't help with that" } }));
    await expect(structured(call)).rejects.toBeInstanceOf(RefusalError);

    fakeFetch(402, { error: { code: 402, message: "Insufficient credits" } });
    const e402 = await structured(call).catch((e) => e);
    expect(e402).toBeInstanceOf(LlmHttpError);
    expect(isFatal(e402)).toBe(true);

    fakeFetch(429, { error: { code: 429, message: "rate limited" } });
    const e429 = await structured(call).catch((e) => e);
    expect(isRetryable(e429)).toBe(true);
    expect(isFatal(e429)).toBe(false);
  });
});
