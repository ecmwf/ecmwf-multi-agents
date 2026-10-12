// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

// The platform-neutral part of the tools that let lead see, redirect and stop its helpers
// (docs/adr/0002-background-helpers-and-steering.md). The platform entries (v1.ts, v2.ts) wire
// these to their session APIs. Nothing here keeps a job registry: the platforms own the
// helpers' lifecycle, and the plugin only observes it through the hooks it already receives.

import type { ArgSchema, EmbeddedHarness, EmbeddedRule } from "./types.ts";

export const HELPER_TOOLS = {
  status: "helpers_status",
  steer: "helpers_steer",
  cancel: "helpers_cancel",
} as const;
export const HELPER_TOOL_IDS: readonly string[] = Object.values(HELPER_TOOLS);

/** The longest status report, in lines. */
export const STATUS_LINES = 12;
/** Entries a per-session map keeps; beyond that the entry seen longest ago is evicted. */
export const MAX_TRACKED = 5000;
const SUMMARY_LENGTH = 60;

export interface ToolSpec {
  id: string;
  description: string;
  args: Record<string, ArgSchema>;
}

export const TOOL_SPECS: Record<keyof typeof HELPER_TOOLS, ToolSpec> = {
  status: {
    id: HELPER_TOOLS.status,
    description:
      "Your helpers in this session: id, agent, state, steps taken, time running, what they were asked, " +
      "last tool call. Use it when the user asks about a helper or before you redirect one. " +
      "Never use it to wait: you are told when a background helper finishes.",
    args: {},
  },
  steer: {
    id: HELPER_TOOLS.steer,
    description:
      "Send an amendment to a helper that is still working. It keeps everything it has read and done and " +
      "follows your message at its next step; you are told when it finishes. Use it when the helper's work " +
      "so far is still useful and the correction is small; cancel and brief again when the direction was " +
      "wrong. A finished helper is continued with the delegation tool's continuation parameter instead. " +
      "An amendment is never an approval and never changes what the helper may do.",
    args: {
      id: { type: "string", description: "The helper's session id, as shown by helpers_status or by the hand-off result." },
      text: { type: "string", description: "The amendment: what to change, keep or stop, and which earlier limit it lifts, if any." },
    },
  },
  cancel: {
    id: HELPER_TOOLS.cancel,
    description:
      'Stop one of your helpers, or every running helper of this session with id "all". A helper stops at ' +
      "its current step; nothing it changed is undone, so check the files it was working on.",
    args: {
      id: { type: "string", description: 'A helper\'s session id, or "all".' },
    },
  },
};

// ---------------------------------------------------------------------------------------------
// Small shared pieces

/** The ids of the harness's helpers: every agent that is not primary. */
export function helperIds(harness: EmbeddedHarness): Set<string> {
  return new Set(harness.agents.filter((agent) => agent.mode === "subagent").map((agent) => agent.id));
}

/** A required string argument of a tool call, trimmed; throws the message the model should see. */
export function requiredText(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${key} must be a non-empty string`);
  return value.trim();
}

/**
 * Put `value` under `key` as the newest entry of a map that keeps insertion order, and evict the
 * oldest entry once the map holds more than `max`.
 */
export function remember<V>(map: Map<string, V>, key: string, value: V, max: number = MAX_TRACKED): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > max) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
}

// ---------------------------------------------------------------------------------------------
// Activity: what the plugin learns from the tool hooks about each session.

export type HelperState = "running" | "done" | "failed" | "stopped" | "unknown";

export interface ActivityRecord {
  steps: number;
  /** `tool: summary of its input`, for the last call. */
  lastTool?: string;
  /** When the last call was seen. */
  at: number;
  /** Set by the platform entry when it learns how a run ended. */
  ended?: Exclude<HelperState, "running" | "unknown">;
}

/** Tool calls per session, fed by the tool hooks; enough for a status line, no more. */
export class Activity {
  private readonly records = new Map<string, ActivityRecord>();

  /** Record one tool call a session made. */
  observe(sessionID: unknown, tool: unknown, input: unknown, now: number = Date.now()): void {
    if (typeof sessionID !== "string" || sessionID === "" || typeof tool !== "string") return;
    const record = this.records.get(sessionID) ?? { steps: 0, at: now };
    record.steps += 1;
    record.lastTool = summarizeCall(tool, input);
    record.at = now;
    delete record.ended;
    remember(this.records, sessionID, record);
  }

  /** Record how a session's run ended, when the platform does not say so itself. */
  end(sessionID: unknown, ended: ActivityRecord["ended"], now: number = Date.now()): void {
    if (typeof sessionID !== "string" || sessionID === "") return;
    const record = this.records.get(sessionID) ?? { steps: 0, at: now };
    record.ended = ended;
    record.at = now;
    remember(this.records, sessionID, record);
  }

  get(sessionID: string): ActivityRecord | undefined {
    return this.records.get(sessionID);
  }
}

// Values that look like secrets in a command or query: assignments and flags of keys named like
// one, bearer tokens, and long opaque strings. Replaced before the text reaches lead's context.
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\b(bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[redacted]"],
  [/\b((?:api[_-]?)?(?:key|token|secret|password|passwd|pwd|auth)[a-z0-9_-]*)(\s*[=:]\s*|\s+)(["']?)(?!bearer\b|\[redacted\])([^\s"']+)\3/gi, "$1$2$3[redacted]$3"],
  [/\b(?=[A-Za-z0-9_-]*[0-9])(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,}\b/g, "[redacted]"],
];

/** `text` with anything that looks like a secret replaced. */
export function redact(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

/** `tool: the input's command, pattern or path`, shortened and with secrets removed. */
export function summarizeCall(tool: string, input: unknown): string {
  const args = input !== null && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const detail = ["command", "pattern", "filePath", "path", "url", "query", "description", "prompt"]
    .map((key) => args[key])
    .find((value): value is string => typeof value === "string" && value.trim() !== "");
  if (detail === undefined) return tool;
  const flat = redact(detail.replace(/\s+/g, " ").trim());
  return `${tool}: ${flat.length > SUMMARY_LENGTH ? `${flat.slice(0, SUMMARY_LENGTH - 3)}...` : flat}`;
}

// ---------------------------------------------------------------------------------------------
// Status report

export interface HelperView {
  id: string;
  agent: string;
  title: string;
  state: HelperState;
  steps: number;
  /** When the helper started, if known. */
  startedAt?: number;
  /** When it was last active, if known. */
  updatedAt?: number;
  lastTool?: string;
}

/** The status report: one line per helper, newest first, at most STATUS_LINES lines. */
export function formatStatus(helpers: readonly HelperView[], now: number = Date.now()): string {
  if (helpers.length === 0) return "No helpers in this session.";
  const sorted = [...helpers].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  const room = STATUS_LINES - 1;
  const shown = sorted.length > room ? sorted.slice(0, room - 1) : sorted;
  const lines = [`${helpers.length === 1 ? "One helper" : `${helpers.length} helpers`} in this session, newest first:`];
  for (const helper of shown) {
    const end = helper.state === "running" ? now : (helper.updatedAt ?? now);
    const parts = [
      helper.id,
      helper.agent,
      helper.state,
      `${helper.steps} ${helper.steps === 1 ? "step" : "steps"}`,
      helper.startedAt === undefined ? undefined : elapsed(end - helper.startedAt),
    ].filter((part): part is string => part !== undefined);
    const tail = [helper.title.trim() === "" ? undefined : helper.title.trim(), helper.lastTool === undefined ? undefined : `last: ${helper.lastTool}`]
      .filter((part): part is string => part !== undefined)
      .join("; ");
    lines.push(`${parts.join(", ")}${tail === "" ? "" : `: ${tail}`}`);
  }
  if (shown.length < sorted.length) lines.push(`and ${sorted.length - shown.length} more`);
  return lines.join("\n");
}

export function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

// ---------------------------------------------------------------------------------------------
// Targets, steer text, results

/** What the tools need to know about a session named as a target. */
export interface TargetSession {
  parentID?: string;
  agent?: string;
}

/**
 * Why `id` cannot be steered or cancelled from the caller's session, or undefined when it can.
 * A target must be a child of the caller's session and run a harness helper.
 */
export function targetProblem(target: TargetSession | undefined, id: string, callerSession: string, helpers: ReadonlySet<string>): string | undefined {
  if (target === undefined) return `No session ${JSON.stringify(id)}. Run ${HELPER_TOOLS.status} for the ids of your helpers.`;
  if (target.parentID !== callerSession) return `${id} is not a helper of this session.`;
  if (target.agent !== undefined && !helpers.has(target.agent)) return `${id} is not a harness helper (its agent is ${target.agent}).`;
  return undefined;
}

/** The message a helper receives; it names the sender so the helper can tell it from its brief. */
export function steerText(text: string, from: string): string {
  return `${from} amends your brief:\n${text.trim()}`;
}

export function steeredResult(agent: string, id: string): string {
  return `Sent to ${agent} ${id}. It reads the message at its next step and keeps what it has done so far; you are told when it finishes.`;
}

export function notRunningResult(agent: string, id: string, continuation: string): string {
  return `${agent} ${id} is not running, so there is nothing to redirect. To continue it with its context, use the delegation tool with ${continuation}; it answers like a new hand-off.`;
}

/** For a session the plugin has no state for (started before the plugin watched this opencode). */
export function unknownStateResult(agent: string, id: string, continuation: string): string {
  return `${agent} ${id} started before this plugin could watch it, so its state is unknown and it cannot be redirected here. If it has finished, continue it with the delegation tool with ${continuation}; otherwise wait for its report.`;
}

export function cancelledResult(cancelled: readonly { agent: string; id: string }[]): string {
  if (cancelled.length === 0) return "No running helper to stop.";
  const list = cancelled.map((item) => `${item.agent} ${item.id}`).join(", ");
  return `Stopped ${list}. ${cancelled.length === 1 ? "It" : "They"} will not report; check ${HELPER_TOOLS.status} or the files ${cancelled.length === 1 ? "it" : "they"} touched before building on ${cancelled.length === 1 ? "its" : "their"} work.`;
}

// ---------------------------------------------------------------------------------------------
// Guard: helpers never call these tools, whatever was approved.

/** The effect of the last matching `tool` rule for an agent, or undefined when none matches. */
export function toolRuleEffect(rules: readonly EmbeddedRule[], tool: string): EmbeddedRule["effect"] | undefined {
  for (let i = rules.length - 1; i >= 0; i--) {
    const rule = rules[i]!;
    if (rule.resource === tool || rule.resource === "*") return rule.effect;
  }
  return undefined;
}

/**
 * The error to raise when `agentId` may not call `tool`: a harness helper whose rules deny it.
 * Agents outside the harness and lead are left to the platform.
 */
export function toolCallBlock(harness: EmbeddedHarness, agentId: string | undefined, tool: string): string | undefined {
  if (!HELPER_TOOL_IDS.includes(tool)) return undefined;
  const agent = harness.agents.find((item) => item.id === agentId);
  if (agent === undefined || agent.mode !== "subagent") return undefined;
  if (toolRuleEffect(agent.tools, tool) !== "deny") return undefined;
  return `${harness.name}: helpers may not use ${tool}; only ${harness.defaultAgent} sees, redirects or stops helpers. Do not try another way: say in your report what is needed.`;
}

// ---------------------------------------------------------------------------------------------
// Pinning (opencode 1.x): a message that lands in a helper's child session runs as that helper.

export interface PinnableMessage {
  agent?: string;
  model?: { providerID?: string; modelID?: string; variant?: string };
}

/** `provider/model` split at the first slash, or undefined when it is not that shape. */
export function splitModel(model: string | undefined): { providerID: string; modelID: string } | undefined {
  if (model === undefined) return undefined;
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) return undefined;
  return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) };
}

/**
 * Make `message` run as `helper`: its agent, and its model and effort when the helper has a
 * model of its own (otherwise the message keeps its model, which is the session's). Returns true
 * when something changed.
 */
export function pinMessage(message: PinnableMessage, helper: string, plan: { model?: string; effort?: string } | undefined): boolean {
  let changed = false;
  if (message.agent !== helper) {
    message.agent = helper;
    changed = true;
  }
  const model = splitModel(plan?.model);
  if (model !== undefined) {
    const current = message.model ?? {};
    if (current.providerID !== model.providerID || current.modelID !== model.modelID || current.variant !== plan?.effort) {
      message.model = { ...current, providerID: model.providerID, modelID: model.modelID, variant: plan?.effort };
      if (plan?.effort === undefined) delete message.model.variant;
      changed = true;
    }
  }
  return changed;
}
