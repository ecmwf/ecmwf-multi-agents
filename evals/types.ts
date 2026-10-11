// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

// Shared types of the scenario evals: cases, answering policies, checks, metrics and the
// record written for each run.

export type Variant = "harness" | "baseline";
export const VARIANTS: readonly Variant[] = ["harness", "baseline"];

export type ReviewPolicy = "auto" | "ask" | "always" | "never";
export type PermissionReply = "once" | "always" | "reject";

/** One step applied to a fresh copy of the fixture before a run. */
export type SetupStep =
  /** Write a file; mtime (ISO 8601) sets its modification time. */
  | { kind: "write"; path: string; content: string; mtime?: string }
  /** Replace text that must occur exactly once in the file. */
  | { kind: "replace"; path: string; find: string; replace: string }
  | { kind: "remove"; path: string }
  /** Stage everything and commit with the fixed identity and date. */
  | { kind: "commit"; message: string }
  /** A local bare repository named origin, with the current branch pushed to it. */
  | { kind: "remote" }
  /** List the harness work folder in .git/info/exclude, as lead does before its first work file. */
  | { kind: "exclude-workdir" };

export type Turn = { kind: "prompt"; text: string } | { kind: "command"; command: string; arguments?: string };

/** What a turn condition can see after the earlier turns. */
export interface TurnState {
  project: string;
  answers: string[];
  readFile(rel: string): string | undefined;
  listFiles(relDir: string): string[];
}

export interface TurnStep {
  turn: Turn;
  /** Start a new root session for this turn instead of continuing the current one. */
  newSession?: boolean;
  /** Run this turn only when the condition holds after the earlier turns. */
  when?: (state: TurnState) => boolean;
  /** Why the turn exists, for the record. */
  note?: string;
}

/** A pending permission request, as GET /permission returns it. */
export interface PermissionRequest {
  id: string;
  sessionID: string;
  permission: string;
  patterns: string[];
  always?: string[];
  metadata?: Record<string, unknown>;
  tool?: { messageID: string; callID: string };
}

export interface QuestionOption {
  label: string;
  description?: string;
}

/** A pending question, as GET /question returns it. */
export interface QuestionRequest {
  id: string;
  sessionID: string;
  questions: Array<{ question: string; header?: string; options: QuestionOption[]; multiple?: boolean; custom?: boolean }>;
  tool?: { messageID: string; callID: string };
}

export interface PermissionRule {
  /** Permission name, such as bash or edit; leave out to match any. */
  permission?: string;
  /** Tested against each pattern of the request. */
  pattern: RegExp;
  reply: PermissionReply;
  reason: string;
}

/** How the runner answers on the user's behalf. */
export interface AnsweringPolicy {
  /** First matching rule wins. */
  permissions: PermissionRule[];
  /** Reply when no rule matches. */
  fallback: PermissionReply;
  /** Question answers: the first option of each question. */
  questions: "first-option";
}

export interface PermissionRecord {
  id: string;
  sessionID: string;
  agent: string;
  permission: string;
  patterns: string[];
  reply: PermissionReply;
  reason: string;
  at: number;
}

export interface QuestionRecord {
  id: string;
  sessionID: string;
  agent: string;
  questions: Array<{ question: string; options: string[] }>;
  answers: string[][];
  at: number;
}

// ---------------------------------------------------------------------------------------------
// opencode 1.x messages, reduced to the fields the evals read.

export interface ApiTokens {
  input?: number;
  output?: number;
  reasoning?: number;
  cache?: { read?: number; write?: number };
}

export interface ApiPart {
  id?: string;
  type: string;
  text?: string;
  synthetic?: boolean;
  tool?: string;
  callID?: string;
  state?: {
    status: string;
    input?: Record<string, unknown>;
    output?: string;
    error?: string;
    time?: { start?: number; end?: number };
  };
  cost?: number;
  tokens?: ApiTokens;
  agent?: string;
  prompt?: string;
  description?: string;
  command?: string;
}

export interface ApiMessage {
  info: {
    id: string;
    sessionID: string;
    role: string;
    agent?: string;
    mode?: string;
    modelID?: string;
    providerID?: string;
    model?: { providerID?: string; modelID?: string; variant?: string };
    variant?: string;
    cost?: number;
    tokens?: ApiTokens;
    time?: { created?: number; completed?: number };
    error?: unknown;
    finish?: string;
  };
  parts: ApiPart[];
}

export interface SessionData {
  id: string;
  parentID?: string;
  title?: string;
  messages: ApiMessage[];
}

// ---------------------------------------------------------------------------------------------
// Metrics

export interface Tokens {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
}

export type DenialKind = "rule" | "user" | "guard";

export interface ToolCall {
  sessionID: string;
  agent: string;
  tool: string;
  status: string;
  input: Record<string, unknown>;
  /** Shell command text, for shell tool calls. */
  command?: string;
  error?: string;
  denied?: DenialKind;
  start?: number;
  end?: number;
}

export interface AgentMetrics {
  cost: number;
  tokens: Tokens;
  /** Model requests (steps). */
  requests: number;
  /** provider/model, with the variant when one was set. */
  models: string[];
  /** Sessions this agent ran: child sessions for helpers. */
  sessions: number;
  toolCalls: number;
  deniedToolCalls: number;
  toolsByName: Record<string, number>;
  shellCommands: string[];
  /** Largest input plus cache tokens of one request. */
  peakContext: number;
  questions: number;
  permissions: number;
}

export interface Metrics {
  cost: number;
  tokens: Tokens;
  requests: number;
  /** The agent that holds the conversation: lead for the harness, build for the baseline. */
  mainAgent: string;
  mainPeakContext: number;
  agents: Record<string, AgentMetrics>;
  /** Child sessions per agent (every session except the root ones). */
  childSessions: Record<string, number>;
  toolCalls: ToolCall[];
  errors: string[];
}

// ---------------------------------------------------------------------------------------------
// Checks

export interface CheckResult {
  pass: boolean;
  detail: string;
}

export interface CommandResult {
  code: number;
  output: string;
}

/** What a check can see after a run. */
export interface CheckContext {
  variant: Variant;
  project: string;
  /** HEAD after setup, and the bare remote when the case has one. */
  setup: { head: string; remote?: string };
  /** Final answer of the last turn. */
  answer: string;
  /** Final answer of every turn, in order. */
  answers: string[];
  /** Final text of every session in the run, with its agent. */
  reports: Array<{ agent: string; sessionID: string; text: string }>;
  /** Files added, changed or removed since setup, outside .git and Python caches. */
  changedFiles: string[];
  metrics: Metrics;
  permissions: PermissionRecord[];
  questions: QuestionRecord[];
  readFile(rel: string): string | undefined;
  listFiles(relDir: string): string[];
  /** Run a command in the project with the run's git identity. */
  exec(argv: string[], options?: { cwd?: string; env?: Record<string, string> }): CommandResult;
  /** Folder of a case's hidden tests. */
  hiddenTests(caseId: string): string;
}

export interface Check {
  id: string;
  title: string;
  /** Variants the check runs for; default both. */
  variants?: Variant[];
  /** Variants for which the result is recorded but does not decide the run's pass. */
  recordOnly?: Variant[];
  run(ctx: CheckContext): CheckResult;
}

export interface CheckOutcome extends CheckResult {
  id: string;
  title: string;
  recordOnly: boolean;
}

export interface EvalCase {
  id: string;
  title: string;
  setup: SetupStep[];
  turns: TurnStep[];
  /** Review policy for the harness install; default auto. */
  review?: ReviewPolicy;
  /** Changes to the default answering policy. */
  answering?: Partial<AnsweringPolicy>;
  checks: Check[];
  /** Whether the case also runs on plain opencode with its build agent. */
  baseline: boolean;
}

// ---------------------------------------------------------------------------------------------
// Run record

export type RunStatus = "completed" | "timeout" | "error";

export interface TurnRecord {
  turn: Turn;
  note?: string;
  skipped: boolean;
  sessionID?: string;
  agent?: string;
  status?: RunStatus;
  error?: string;
  durationMs?: number;
  answer?: string;
}

export interface TranscriptPart {
  type: string;
  text?: string;
  tool?: string;
  status?: string;
  input?: unknown;
  output?: string;
  error?: string;
  agent?: string;
  cost?: number;
  tokens?: Tokens;
}

export interface TranscriptMessage {
  role: string;
  agent: string;
  model?: string;
  cost?: number;
  error?: string;
  parts: TranscriptPart[];
}

export interface TranscriptSession {
  id: string;
  parentID?: string;
  title?: string;
  agent: string;
  messages: TranscriptMessage[];
}

export interface RunRecord {
  case: string;
  title: string;
  variant: Variant;
  repeat: number;
  profile: string;
  review: ReviewPolicy;
  opencode: { bin: string; version: string };
  started: string;
  durationMs: number;
  status: RunStatus;
  error?: string;
  pass: boolean;
  turns: TurnRecord[];
  rootSessions: string[];
  metrics: Metrics;
  permissions: PermissionRecord[];
  questions: QuestionRecord[];
  changedFiles: string[];
  diff: string;
  checks: CheckOutcome[];
  transcript: TranscriptSession[];
}
