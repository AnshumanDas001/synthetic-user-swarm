// Runtime configuration from environment variables (and .env), with defaults that match the spec
// while staying cheap: every role defaults to one inexpensive vision model on OpenRouter.
import fs from "node:fs";
import path from "node:path";

// Load .env from the project root if present (Node 21.7+). Real environment variables win.
if (fs.existsSync(".env")) {
  try {
    process.loadEnvFile(".env");
  } catch {}
}

const env = process.env;
const CHEAP = "anthropic/claude-haiku-5.5";

const num = (v: string | undefined, d: number) => (v === undefined || v === "" ? d : Number(v));

export const config = {
  dataDir: path.resolve(env.SWARM_DATA_DIR ?? "data"),
  // Render (and most hosts) inject PORT.
  port: Number(env.SWARM_PORT ?? env.PORT ?? 4300),
  // Public origin, used for the Google OAuth redirect. Render sets RENDER_EXTERNAL_URL.
  publicUrl: (env.PUBLIC_URL ?? env.RENDER_EXTERNAL_URL ?? "").replace(/\/$/, ""),

  // "live" calls models through OpenRouter; "mock" uses a deterministic heuristic policy and critic (tests, CI, offline).
  modelMode: (env.SWARM_MODEL_MODE ?? (env.OPENROUTER_API_KEY ? "live" : "mock")) as "live" | "mock",
  // OpenRouter model ids. Any vision model with structured-output support works for the step model.
  models: {
    step: env.SWARM_STEP_MODEL ?? CHEAP,
    escalation: env.SWARM_ESCALATION_MODEL ?? CHEAP,
    critic: env.SWARM_CRITIC_MODEL ?? CHEAP,
    synthesis: env.SWARM_SYNTHESIS_MODEL ?? CHEAP,
    judge: env.SWARM_JUDGE_MODEL ?? CHEAP,
    generator: env.SWARM_GENERATOR_MODEL ?? CHEAP,
    // Only for scoring the seeded-defect benchmark: rare and small, so a stronger judge is affordable.
    benchmark: env.SWARM_BENCHMARK_MODEL ?? "anthropic/claude-sonnet-5.5",
  },
  // Reasoning effort per role. When stuck, the agent escalates by thinking harder for a few steps
  // (and switches model only if SWARM_ESCALATION_MODEL names a different one).
  effort: {
    step: (env.SWARM_STEP_EFFORT ?? "low") as "low" | "medium" | "high",
    escalation: (env.SWARM_ESCALATION_EFFORT ?? "high") as "low" | "medium" | "high",
    critic: (env.SWARM_CRITIC_EFFORT ?? "medium") as "low" | "medium" | "high",
  },
  escalationSteps: 3,

  // Credit guards: never spend below this reserve, and cap every study at the credit actually left.
  creditReserveUsd: Number(env.SWARM_CREDIT_RESERVE_USD ?? 0.5),
  // Longest screenshot side sent to the model; smaller images cost fewer input tokens.
  modelImageMaxWidth: Number(env.SWARM_IMAGE_MAX_WIDTH ?? 1024),

  // Multi-user hosting: Google sign-in, per-user studies, one free run each, bring-your-own key.
  google: { clientId: env.GOOGLE_CLIENT_ID ?? "", clientSecret: env.GOOGLE_CLIENT_SECRET ?? "" },
  adminEmails: (env.SWARM_ADMIN_EMAILS ?? "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean),
  databaseUrl: env.DATABASE_URL ?? "",
  limits: {
    freeRuns: num(env.SWARM_FREE_RUNS, 1),
    freeMaxSessions: num(env.SWARM_FREE_MAX_SESSIONS, 6),
    freeMaxSteps: num(env.SWARM_FREE_MAX_STEPS, 20),
    freeCostCapUsd: num(env.SWARM_FREE_COST_CAP_USD, 0.1),
    // All free runs together may spend at most this per UTC day on the platform key.
    platformDailyCapUsd: num(env.SWARM_PLATFORM_DAILY_CAP_USD, 0.5),
    userMaxSessions: num(env.SWARM_USER_MAX_SESSIONS, 24),
    maxActiveStudies: num(env.SWARM_MAX_ACTIVE_STUDIES, 2),
  },
  // host or host:port entries the browsers may reach even though they are private (e.g. the bundled demo shop).
  privateHostsAllowed: (env.SWARM_PRIVATE_HOSTS_ALLOWED ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean),
  demoShop: env.SWARM_DEMO_SHOP === "1",
  demoShopPort: num(env.SWARM_DEMO_SHOP_PORT, 4400),

  userAgentSuffix: env.SWARM_UA ?? "SyntheticUserSwarm/0.1 (+usability testing; contact site owner)",
  headless: env.SWARM_HEADFUL !== "1",
  perDomainConcurrency: Number(env.SWARM_PER_DOMAIN_CONCURRENCY ?? 8),
  historySteps: 6,
};

export const multiUser = (): boolean => !!config.google.clientId;
