// LLM client over OpenRouter's OpenAI-compatible chat API: structured JSON outputs validated by zod,
// reasoning effort, refusal handling, prompt caching for the stable prefix, and exact per-call cost
// (OpenRouter reports what each request was billed).
import { z } from "zod";
import { AsyncLocalStorage } from "node:async_hooks";
import { config } from "../config.js";

// The API key for the work running in this async context (a study on a user's own key), else the server's.
const keyContext = new AsyncLocalStorage<{ apiKey: string }>();
export function withApiKey<T>(apiKey: string | null | undefined, fn: () => Promise<T>): Promise<T> {
  return apiKey ? keyContext.run({ apiKey }, fn) : fn();
}

const BASE = process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1";

export interface LlmUsage {
  model: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
}

// OpenAI-style content parts; OpenRouter forwards cache_control to providers that support it.
export type ContentPart =
  | { type: "text"; text: string; cache_control?: { type: "ephemeral" } }
  | { type: "image_url"; image_url: { url: string; detail?: "low" | "high" | "auto" } };

export type Effort = "low" | "medium" | "high";

export interface StructuredCall<T extends z.ZodType> {
  model: string;
  schema: T;
  system: string;
  content: ContentPart[];
  effort?: Effort;
  maxTokens?: number;
  // Name for the JSON schema (shows up in OpenRouter's logs).
  name?: string;
}

export class RefusalError extends Error {}

// Errors carry the HTTP status so callers can decide between retry, stop the study, or give up.
export class LlmHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function apiKey(): string {
  const key = keyContext.getStore()?.apiKey ?? process.env.OPENROUTER_API_KEY;
  if (!key) throw new LlmHttpError(401, "OPENROUTER_API_KEY is not set");
  return key;
}

function headers(): Record<string, string> {
  return {
    authorization: `Bearer ${apiKey()}`,
    "content-type": "application/json",
    // Attribution headers OpenRouter shows in its dashboard.
    "HTTP-Referer": "https://github.com/synthetic-user-swarm",
    "X-Title": "Synthetic User Swarm",
  };
}

interface ChatResponse {
  model: string;
  choices?: { finish_reason: string | null; native_finish_reason?: string | null; message: { content: string | null; refusal?: string | null } }[];
  usage?: { prompt_tokens: number; completion_tokens: number; cost?: number; prompt_tokens_details?: { cached_tokens?: number } };
  error?: { code: number; message: string };
}

export async function structured<T extends z.ZodType>(call: StructuredCall<T>): Promise<{ value: z.infer<T>; usage: LlmUsage }> {
  const original = z.toJSONSchema(call.schema, { io: "output", reused: "inline" }) as JsonSchema;
  const schema = toStrictSchema(original);
  const body = {
    model: call.model,
    max_tokens: call.maxTokens ?? 6000,
    messages: [
      // The system prompt (persona card + instructions) repeats on every step: mark it cacheable.
      { role: "system", content: [{ type: "text", text: call.system, cache_control: { type: "ephemeral" } }] },
      { role: "user", content: call.content },
    ],
    response_format: { type: "json_schema", json_schema: { name: call.name ?? "output", strict: true, schema } },
    reasoning: { effort: call.effort ?? "low", exclude: true },
    // Only route to providers that honour structured outputs; report the exact cost of each call.
    provider: { require_parameters: true },
    usage: { include: true },
  };

  const res = await fetch(`${BASE}/chat/completions`, { method: "POST", headers: headers(), body: JSON.stringify(body), signal: AbortSignal.timeout(180_000) })
    .catch((e: Error) => { throw new LlmHttpError(0, `network error: ${e.message}`); });
  const json = (await res.json().catch(() => ({}))) as ChatResponse;
  if (!res.ok || json.error) throw new LlmHttpError(json.error?.code ?? res.status, `OpenRouter ${json.error?.code ?? res.status}: ${json.error?.message ?? res.statusText}`);

  const choice = json.choices?.[0];
  if (!choice) throw new LlmHttpError(502, "OpenRouter returned no choices");
  if (choice.message.refusal || choice.finish_reason === "content_filter" || choice.native_finish_reason === "refusal") {
    throw new RefusalError(`model refused: ${choice.message.refusal ?? choice.native_finish_reason ?? choice.finish_reason}`);
  }
  if (choice.finish_reason === "length") throw new Error("structured output truncated at max_tokens");

  const u = json.usage ?? { prompt_tokens: 0, completion_tokens: 0 };
  const usage: LlmUsage = {
    model: json.model ?? call.model,
    tokensIn: u.prompt_tokens,
    tokensOut: u.completion_tokens,
    costUsd: u.cost ?? (await estimateCost(call.model, u.prompt_tokens, u.completion_tokens)),
  };

  const parsed = call.schema.safeParse(stripOptionalNulls(parseJson(choice.message.content ?? ""), original));
  if (!parsed.success) throw new SchemaError(`output did not match the schema: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`, usage);
  return { value: parsed.data, usage };
}

// Raised after a call that was billed but returned unusable output, so the cost is still counted.
export class SchemaError extends Error {
  constructor(message: string, readonly usage: LlmUsage) {
    super(message);
  }
}

function parseJson(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "");
  try {
    return JSON.parse(t);
  } catch {
    const start = t.indexOf("{");
    const end = t.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(t.slice(start, end + 1));
    throw new Error("model output was not JSON");
  }
}

export function imageBlock(jpeg: Buffer): ContentPart {
  return { type: "image_url", image_url: { url: `data:image/jpeg;base64,${jpeg.toString("base64")}` } };
}

export function textBlock(text: string): ContentPart {
  return { type: "text", text };
}

// ---------------------------------------------------------------- strict JSON schema

type JsonSchema = { [k: string]: unknown };

const DROP = ["$schema", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minLength", "maxLength", "pattern", "format", "default", "maxItems"];

// Strict structured outputs need every property required and no extra properties. Optional fields
// become nullable (nulls are stripped before zod validation), range constraints are dropped (zod
// still enforces them), and `const` becomes a one-value enum for wider provider support.
export function toStrictSchema(s: JsonSchema): JsonSchema {
  const out: JsonSchema = {};
  for (const [k, v] of Object.entries(s)) {
    if (DROP.includes(k)) continue;
    if (k === "minItems" && typeof v === "number" && v > 1) continue;
    out[k] = v;
  }
  if ("const" in out) {
    out.enum = [out.const];
    delete out.const;
  }
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    if (Array.isArray(out[key])) out[key] = (out[key] as JsonSchema[]).map(toStrictSchema);
  }
  if (out.oneOf) {
    out.anyOf = out.oneOf;
    delete out.oneOf;
  }
  if (out.items && typeof out.items === "object") out.items = toStrictSchema(out.items as JsonSchema);
  if (out.type === "object" && out.properties) {
    const props = out.properties as Record<string, JsonSchema>;
    const required = new Set((out.required as string[] | undefined) ?? []);
    const next: Record<string, JsonSchema> = {};
    for (const [name, p] of Object.entries(props)) {
      const strict = toStrictSchema(p);
      next[name] = required.has(name) ? strict : { anyOf: [strict, { type: "null" }] };
    }
    out.properties = next;
    out.required = Object.keys(next);
    out.additionalProperties = false;
  }
  return out;
}

export function stripNulls(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripNulls);
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) if (x !== null) o[k] = stripNulls(x);
    return o;
  }
  return v;
}

// Undo toStrictSchema's optional→nullable rewrite: drop a null only where the original schema had the
// property as optional. Genuinely nullable fields (required, null allowed) keep their null.
export function stripOptionalNulls(v: unknown, schema: JsonSchema | undefined): unknown {
  if (!schema) return v;
  if (Array.isArray(v)) return v.map((x) => stripOptionalNulls(x, schema.items as JsonSchema | undefined));
  if (!v || typeof v !== "object") return v;
  const branches = [schema, ...((schema.anyOf ?? schema.oneOf ?? []) as JsonSchema[])].filter((b) => b.properties);
  const o: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) {
    const branch = branches.find((b) => k in (b.properties as Record<string, unknown>));
    const optional = !!branch && !((branch.required as string[] | undefined) ?? []).includes(k);
    if (x === null && optional) continue;
    o[k] = stripOptionalNulls(x, branch ? (branch.properties as Record<string, JsonSchema>)[k] : undefined);
  }
  return o;
}

// ---------------------------------------------------------------- pricing, credits, preflight

let catalogue: Map<string, { in: number; out: number; vision: boolean; structured: boolean }> | null = null;

export async function modelCatalogue() {
  if (catalogue) return catalogue;
  const res = await fetch(`${BASE}/models`, { signal: AbortSignal.timeout(30_000) });
  const { data } = (await res.json()) as { data: { id: string; pricing: { prompt: string; completion: string }; architecture?: { input_modalities?: string[] }; supported_parameters?: string[] }[] };
  catalogue = new Map(data.map((m) => [m.id, {
    in: Number(m.pricing.prompt) * 1e6,
    out: Number(m.pricing.completion) * 1e6,
    vision: !!m.architecture?.input_modalities?.includes("image"),
    structured: !!m.supported_parameters?.includes("structured_outputs"),
  }]));
  return catalogue;
}

// Fallback when a response carries no cost: list price × tokens.
async function estimateCost(model: string, tokensIn: number, tokensOut: number): Promise<number> {
  const p = (await modelCatalogue().catch(() => null))?.get(model);
  return p ? (tokensIn * p.in + tokensOut * p.out) / 1e6 : 0;
}

// Credit left on this key (OpenRouter key limit, or account credits when the key has no limit).
export async function creditsRemaining(): Promise<{ remainingUsd: number | null; usedUsd: number; limitUsd: number | null }> {
  const res = await fetch(`${BASE}/key`, { headers: headers(), signal: AbortSignal.timeout(20_000) });
  if (res.status === 401 || res.status === 403) throw new LlmHttpError(res.status, "OpenRouter rejected the API key");
  const { data } = (await res.json()) as { data: { limit: number | null; limit_remaining: number | null; usage: number } };
  if (data.limit_remaining != null) return { remainingUsd: data.limit_remaining, usedUsd: data.usage, limitUsd: data.limit };
  const credits = await fetch(`${BASE}/credits`, { headers: headers() }).then((r) => r.json()).catch(() => null) as { data?: { total_credits: number; total_usage: number } } | null;
  if (credits?.data) return { remainingUsd: credits.data.total_credits - credits.data.total_usage, usedUsd: credits.data.total_usage, limitUsd: credits.data.total_credits };
  return { remainingUsd: null, usedUsd: data.usage, limitUsd: data.limit };
}

// Fail fast before launching a swarm: the key works, the models exist and can see images and
// return structured JSON. Returns the credit left so the study cap can be clamped to it.
export async function preflight(models: string[]): Promise<{ remainingUsd: number | null }> {
  const credits = await creditsRemaining().catch((e) => {
    if (e instanceof LlmHttpError) throw new Error(`${e.message}. Set a valid OPENROUTER_API_KEY in .env, or run offline with SWARM_MODEL_MODE=mock.`);
    throw e;
  });
  if (credits.remainingUsd !== null && credits.remainingUsd <= config.creditReserveUsd) {
    throw new Error(`only $${credits.remainingUsd.toFixed(2)} of OpenRouter credit left (reserve is $${config.creditReserveUsd}); top up or lower SWARM_CREDIT_RESERVE_USD`);
  }
  const cat = await modelCatalogue();
  for (const m of new Set(models)) {
    const info = cat.get(m);
    if (!info) throw new Error(`model ${m} is not on OpenRouter (check the id at https://openrouter.ai/models)`);
    if (!info.structured) throw new Error(`model ${m} does not support structured outputs on OpenRouter`);
  }
  if (!cat.get(config.models.step)?.vision) throw new Error(`step model ${config.models.step} cannot read images`);
  return credits;
}

// Credentials, permissions or credit are wrong: no retry will help, so the study stops.
export function isFatal(err: unknown): boolean {
  return err instanceof LlmHttpError && [401, 402, 403].includes(err.status);
}

export function isRetryable(err: unknown): boolean {
  return err instanceof LlmHttpError && (err.status === 0 || err.status === 408 || err.status === 429 || err.status >= 500);
}
