// Shared schemas. Everything that crosses a module boundary or touches disk is
// validated here, so a malformed persona card or study file fails loudly at load time.
import { z } from "zod";

// ---------------------------------------------------------------- personas

export const ReadingStyle = z.enum(["skim", "normal", "thorough"]);
export type ReadingStyle = z.infer<typeof ReadingStyle>;

export const NetworkProfile = z.enum(["fast", "4g", "slow-4g", "3g"]);
export type NetworkProfile = z.infer<typeof NetworkProfile>;

export const ColorVision = z.enum(["normal", "deuteranopia", "protanopia", "tritanopia", "achromatopsia"]);

export const PersonaCard = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/, "persona id must be kebab-case"),
  name: z.string(),
  archetype: z.string(),
  locale: z.string().default("en-US"),
  non_native: z.boolean().default(false),
  device: z.object({
    viewport: z.string().regex(/^\d+x\d+$/).default("1280x800"),
    touch: z.boolean().default(false),
    network: NetworkProfile.default("fast"),
    mobile: z.boolean().optional(),
  }).default({ viewport: "1280x800", touch: false, network: "fast" }),
  digital_literacy: z.number().int().min(1).max(5),
  domain_knowledge: z.number().int().min(1).max(5),
  goal_framing: z.string().optional(),
  reading: ReadingStyle.default("normal"),
  patience: z.object({
    max_steps: z.number().int().min(3).max(200).default(30),
    max_retries_per_obstacle: z.number().int().min(0).max(10).default(3),
  }).default({ max_steps: 30, max_retries_per_obstacle: 3 }),
  accessibility: z.object({
    zoom: z.number().min(50).max(400).default(100),
    screen_reader: z.boolean().default(false),
    keyboard_only: z.boolean().default(false),
    color_vision: ColorVision.default("normal"),
  }).default({ zoom: 100, screen_reader: false, keyboard_only: false, color_vision: "normal" }),
  quirks: z.array(z.string()).default([]),
  // Words the persona does not understand. Enforced in the prompt (spec: "Knowledge and language").
  vocabulary_gaps: z.array(z.string()).default([]),
  // Optional per-persona step model, to counter the "homogeneity" bias by mixing models.
  model: z.string().optional(),
  timezone: z.string().optional(),
  geolocation: z.object({ latitude: z.number(), longitude: z.number() }).optional(),
  // Free-form demographic tags used by the stratified sampler.
  tags: z.array(z.string()).default([]),
});
export type PersonaCard = z.infer<typeof PersonaCard>;

// What the runtime enforces, derived from a card (spec: "every trait maps to a mechanism").
export interface PerceptionProfile {
  screenshot: "full" | "none";
  colorVision: z.infer<typeof ColorVision>;
  skim: boolean;
  skimWords: number;
  zoom: number;
}
export interface ActionProfile {
  keyboardOnly: boolean;
  allowGoto: boolean;
  touch: boolean;
}
export interface PersonaBudget {
  maxSteps: number;
  maxRetriesPerObstacle: number;
  wallClockMs: number;
  maxTokens: number;
}

// ---------------------------------------------------------------- study

export const SuccessCriteria = z.object({
  mode: z.enum(["all", "any"]).default("any"),
  url_pattern: z.string().optional(),
  text_present: z.string().optional(),
  network: z.object({
    method: z.string().default("POST"),
    url_pattern: z.string(),
    status: z.number().int().optional(),
  }).optional(),
  // Fuzzy goals: an LLM judge reads the final screenshot against this description.
  llm_judge: z.string().optional(),
});
export type SuccessCriteria = z.infer<typeof SuccessCriteria>;

// Scripted steps run before the persona starts, outside the model: logins (secrets come from env vars)
// and setup such as putting an item in the bag so a task can start at checkout.
export const ScriptStep = z.object({
  goto: z.string().optional(),
  fill: z.object({ selector: z.string(), secret: z.string().optional(), value: z.string().optional() }).optional(),
  click: z.string().optional(),
  wait_for_url: z.string().optional(),
  wait_ms: z.number().int().min(0).max(30_000).optional(),
});
export const AuthStep = ScriptStep;

export const TaskSpec = z.object({
  id: z.string(),
  goal: z.string(),
  start_url: z.string().optional(),
  success: SuccessCriteria,
  // Scripted login run outside the model; secrets resolve from the vault (env vars).
  auth: z.array(ScriptStep).optional(),
  // Same shape as auth; runs after it. Use it to put the site in the state the task starts from.
  setup: z.array(ScriptStep).optional(),
  // Actions like "Place order" are blocked unless the study allows them (spec: safety rules).
  allow_irreversible: z.boolean().default(true),
});
export type TaskSpec = z.infer<typeof TaskSpec>;

export const Budget = z.object({
  repetitions: z.number().int().min(1).max(10).default(3),
  max_steps: z.number().int().min(3).max(200).optional(),
  wall_clock_minutes: z.number().min(0.5).max(60).default(10),
  tokens_per_session: z.number().int().default(400_000),
  cost_cap_usd: z.number().min(0).default(1),
  concurrency: z.number().int().min(1).max(100).default(6),
});
export type Budget = z.infer<typeof Budget>;

export const PersonaMix = z.object({
  // Curated persona ids to include as-is.
  include: z.array(z.string()).default([]),
  // Generated personas: LLM fills the schema from a segment description.
  generate: z.array(z.object({ segment: z.string(), count: z.number().int().min(1).max(50) })).default([]),
  // Seeded personas from the site's analytics (device mix, locales).
  seeded_from: z.string().optional(),
  // Target total; the sampler stratifies and de-duplicates to reach it.
  size: z.number().int().min(1).max(100).optional(),
  mobile_share: z.number().min(0).max(1).optional(),
});
export type PersonaMix = z.infer<typeof PersonaMix>;

export const StudySpec = z.object({
  name: z.string(),
  target_url: z.string().url(),
  allowed_domains: z.array(z.string()).min(1),
  // Must be true: only test sites you own or have written permission to test.
  permission_confirmed: z.literal(true, { message: "permission_confirmed must be true: only test sites you own or have written permission to test" }),
  tasks: z.array(TaskSpec).min(1).max(5),
  personas: PersonaMix,
  budget: Budget.default({ repetitions: 3, wall_clock_minutes: 10, tokens_per_session: 400_000, cost_cap_usd: 1, concurrency: 6 }),
  // Optional hook called before each session to reset site state (emptied carts, seeded accounts).
  reset_url: z.string().optional(),
  // Pin the build under test so evidence never mixes two builds.
  build_id: z.string().optional(),
  compare_to: z.string().optional(),
  // Stay out of paths the target's robots.txt disallows (page loads are blocked; in-app route changes are undone).
  respect_robots: z.boolean().default(true),
  seed: z.number().int().default(42),
});
export type StudySpec = z.infer<typeof StudySpec>;

// ---------------------------------------------------------------- agent I/O

export const ExpectationCheck = z.discriminatedUnion("type", [
  z.object({ type: z.literal("url_changes") }),
  z.object({ type: z.literal("url_contains"), value: z.string() }),
  z.object({ type: z.literal("text_appears"), value: z.string() }),
  z.object({ type: z.literal("text_changes"), mark: z.number().int() }),
  z.object({ type: z.literal("element_changes"), mark: z.number().int() }),
  z.object({ type: z.literal("dialog_opens") }),
  z.object({ type: z.literal("focus_moves") }),
  z.object({ type: z.literal("none") }),
]);
export type ExpectationCheck = z.infer<typeof ExpectationCheck>;

export const AgentAction = z.discriminatedUnion("type", [
  z.object({ type: z.literal("click"), mark: z.number().int() }),
  z.object({ type: z.literal("tap"), mark: z.number().int() }),
  z.object({ type: z.literal("type"), mark: z.number().int(), text: z.string(), submit: z.boolean().optional() }),
  z.object({ type: z.literal("select"), mark: z.number().int(), option: z.string() }),
  z.object({ type: z.literal("scroll"), direction: z.enum(["down", "up"]) }),
  z.object({ type: z.literal("hover"), mark: z.number().int() }),
  z.object({ type: z.literal("press"), key: z.string(), times: z.number().int().min(1).max(10).optional() }),
  z.object({ type: z.literal("back") }),
  z.object({ type: z.literal("wait"), seconds: z.number().min(0).max(10) }),
  z.object({ type: z.literal("goto"), url: z.string() }),
  z.object({ type: z.literal("give_up"), reason: z.string() }),
  z.object({ type: z.literal("done"), claim: z.string() }),
]);
export type AgentAction = z.infer<typeof AgentAction>;

export const AgentStepOutput = z.object({
  think_aloud: z.string(),
  confidence: z.number().int().min(1).max(5),
  frustration: z.number().int().min(0).max(10),
  action: AgentAction,
  expectation: z.object({ says: z.string(), check: ExpectationCheck }),
  note: z.string().optional(),
});
export type AgentStepOutput = z.infer<typeof AgentStepOutput>;

// ---------------------------------------------------------------- run-time records

export type SessionStatus =
  | "queued" | "provisioning" | "running"
  | "succeeded" | "gave_up" | "failed" | "infra_error" | "timed_out"
  | "analysed";

export const TERMINAL_STATUSES: SessionStatus[] = ["succeeded", "gave_up", "failed", "infra_error", "timed_out", "analysed"];

export interface MarkedElement {
  mark: number;
  role: string;
  name: string;
  tag: string;
  state: string[];
  inView: boolean;
  selector: string;
  box: { x: number; y: number; width: number; height: number };
  // Viewport-relative box at perception time, for drawing the target on the step's screenshot.
  vbox: { x: number; y: number; width: number; height: number; vw: number; vh: number };
  covered: boolean;
}

// Facts the check stage observed after acting. Pure code, no LLM: signals are derived from these.
export interface StepObservation {
  urlBefore: string;
  urlAfter: string;
  navigated: boolean;
  domChanged: boolean;
  networkCalls: number;
  networkErrors: { url: string; status: number; method: string }[];
  consoleErrors: string[];
  expectationMet: boolean | null;
  dialogOpened: boolean;
  validationMessages: string[];
  actionError?: string;
  targetCovered?: boolean;
  primaryActionOffscreen?: boolean;
  searchZeroResults?: boolean;
  wordsSeen: number;
  layoutShift: number;
  focusChanged: boolean;
  focusedAfter: string | null;
  scrolledIntoView?: boolean;
  blockedByPolicy?: boolean;
  // Layout shift from content that arrived more than 1 s after the page started loading (measured on arrival).
  loadShift?: number;
  targetMoved?: { dx: number; dy: number };
  // A request the action started that took long; domChanged says whether the page showed any progress meanwhile.
  slowRequest?: { url: string; method: string; ms: number; domChangedWhileWaiting: boolean };
}

export interface StepRecord {
  id: string;
  sessionId: string;
  idx: number;
  url: string;
  pagePath: string;
  title: string;
  stateHash: string;
  action: AgentAction;
  thinkAloud: string;
  expectation: AgentStepOutput["expectation"];
  confidence: number;
  frustration: number;
  target?: { mark: number; selector: string; name: string; role: string; box: MarkedElement["box"]; vbox?: MarkedElement["vbox"] } | null;
  observation: StepObservation;
  artifacts: Record<string, string>;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  model: string;
  estHumanMs: number;
  startedAt: number;
  endedAt: number;
}

export type SignalType =
  | "dead_click" | "rage_click" | "expectation_mismatch" | "backtrack" | "loop"
  | "error_shown" | "search_miss" | "scroll_hunt" | "stall" | "give_up" | "task_failed"
  | "accessibility" | "layout" | "slow_response";

export interface SignalRecord {
  id: string;
  stepId: string;
  sessionId: string;
  type: SignalType;
  details: Record<string, unknown>;
}

export const NIELSEN_HEURISTICS = [
  "visibility_of_system_status",
  "match_between_system_and_real_world",
  "user_control_and_freedom",
  "consistency_and_standards",
  "error_prevention",
  "recognition_rather_than_recall",
  "flexibility_and_efficiency_of_use",
  "aesthetic_and_minimalist_design",
  "help_users_recognize_diagnose_recover_from_errors",
  "help_and_documentation",
] as const;
export const NielsenHeuristic = z.enum(NIELSEN_HEURISTICS);

export const Impact = z.enum(["blocked", "major_detour", "minor_friction", "cosmetic"]);
export type Impact = z.infer<typeof Impact>;
export const IMPACT_SCORE: Record<Impact, number> = { blocked: 4, major_detour: 3, minor_friction: 2, cosmetic: 1 };

export const CandidateIssueDraft = z.object({
  title: z.string(),
  description: z.string(),
  page: z.string(),
  element: z.string(),
  heuristic: NielsenHeuristic,
  impact: Impact,
  step_ids: z.array(z.string()).min(1),
  quotes: z.array(z.string()).default([]),
  suggested_fix: z.string().optional(),
});
export type CandidateIssueDraft = z.infer<typeof CandidateIssueDraft>;

export interface CandidateIssue extends CandidateIssueDraft {
  id: string;
  sessionId: string;
  personaId: string;
  taskId: string;
  repetition: number;
  signalTypes: SignalType[];
  quoteRefs: { text: string; stepId: string }[];
  embedding: number[];
}

export type Confidence = "high" | "medium" | "low";

export interface Issue {
  id: string;
  studyId: string;
  taskIds: string[];
  title: string;
  description: string;
  page: string;
  element: string;
  heuristic: string;
  impact: Impact;
  severity: number;
  confidence: Confidence;
  needsReview: boolean;
  reach: { sessions: number; sessionsReachedPage: number; personas: number; repetitions: number; label: string };
  personaIds: string[];
  candidateIds: string[];
  evidenceStepIds: string[];
  quotes: { text: string; stepId: string }[];
  signalTypes: SignalType[];
  suggestedFix?: string;
  status: "open" | "new" | "fixed" | "regressed" | "unchanged";
  fingerprint: string;
}
