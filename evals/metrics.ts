// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

// Metrics of one run, from the messages of its root sessions and every descendant session.
//
// opencode 1.x keeps one assistant message per agent turn. Its `cost` adds up over the turn's
// model requests, while its `tokens` holds the last request only; each request also leaves a
// step-finish part with its own cost and tokens. Tokens and request counts therefore come from
// the step-finish parts, and cost from the message.

import type {
  AgentMetrics,
  ApiMessage,
  ApiTokens,
  DenialKind,
  Metrics,
  PermissionRecord,
  QuestionRecord,
  SessionData,
  ToolCall,
  Tokens,
  TranscriptSession,
} from "./types.ts";

/** Tool names that run shell commands (opencode 1.x calls it bash). */
export const SHELL_TOOLS = new Set(["bash", "shell"]);

export function emptyTokens(): Tokens {
  return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
}

export function tokensOf(tokens: ApiTokens | undefined): Tokens {
  const n = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  return {
    input: n(tokens?.input),
    output: n(tokens?.output),
    reasoning: n(tokens?.reasoning),
    cacheRead: n(tokens?.cache?.read),
    cacheWrite: n(tokens?.cache?.write),
  };
}

export function addTokens(a: Tokens, b: Tokens): Tokens {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    reasoning: a.reasoning + b.reasoning,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
  };
}

/** Context of one request: everything the model read, cached or not. */
export function contextOf(tokens: Tokens): number {
  return tokens.input + tokens.cacheRead + tokens.cacheWrite;
}

/** The agent that ran a session: from its first user message, else its first assistant message. */
export function sessionAgent(session: Pick<SessionData, "messages">): string {
  for (const message of session.messages) {
    if (message.info.role === "user" && message.info.agent) return message.info.agent;
  }
  for (const message of session.messages) {
    const agent = message.info.agent ?? message.info.mode;
    if (message.info.role === "assistant" && agent) return agent;
  }
  return "unknown";
}

function messageAgent(message: ApiMessage, fallback: string): string {
  return message.info.agent ?? message.info.mode ?? fallback;
}

/** Why a tool call failed, when it was a refusal rather than an ordinary error. */
export function classifyDenial(error: string | undefined): DenialKind | undefined {
  if (!error) return undefined;
  if (error.includes("prevents you from using this specific tool call")) return "rule";
  if (error.includes("The user rejected permission to use this specific tool call")) return "user";
  if (/ecmwf-multi-agents: .* may not run /.test(error)) return "guard";
  return undefined;
}

/** Text of the last assistant message of a session, without synthetic parts. */
export function finalText(session: Pick<SessionData, "messages">): string {
  for (let index = session.messages.length - 1; index >= 0; index--) {
    const message = session.messages[index]!;
    if (message.info.role !== "assistant") continue;
    const text = message.parts
      .filter((part) => part.type === "text" && !part.synthetic && typeof part.text === "string")
      .map((part) => part.text!.trim())
      .filter((part) => part !== "")
      .join("\n\n");
    if (text !== "") return text;
  }
  return "";
}

/** A short description of an assistant error, which opencode stores as a named error object. */
export function errorText(error: unknown): string {
  if (error === undefined || error === null) return "";
  if (typeof error === "string") return error;
  const named = error as { name?: unknown; data?: { message?: unknown }; message?: unknown };
  const message = typeof named.data?.message === "string" ? named.data.message : typeof named.message === "string" ? named.message : "";
  const name = typeof named.name === "string" ? named.name : "Error";
  return message ? `${name}: ${message}` : name;
}

function emptyAgent(): AgentMetrics {
  return {
    cost: 0,
    tokens: emptyTokens(),
    requests: 0,
    models: [],
    sessions: 0,
    toolCalls: 0,
    deniedToolCalls: 0,
    toolsByName: {},
    shellCommands: [],
    peakContext: 0,
    questions: 0,
    permissions: 0,
  };
}

/** Every tool call in the sessions, with its agent, in session and message order. */
export function toolCalls(sessions: SessionData[]): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const session of sessions) {
    const fallback = sessionAgent(session);
    for (const message of session.messages) {
      if (message.info.role !== "assistant") continue;
      const agent = messageAgent(message, fallback);
      for (const part of message.parts) {
        if (part.type !== "tool" || !part.tool) continue;
        const input = part.state?.input ?? {};
        const call: ToolCall = {
          sessionID: session.id,
          agent,
          tool: part.tool,
          status: part.state?.status ?? "unknown",
          input,
        };
        if (SHELL_TOOLS.has(part.tool) && typeof input.command === "string") call.command = input.command;
        if (part.state?.error) call.error = part.state.error;
        const denied = classifyDenial(part.state?.error);
        if (denied) call.denied = denied;
        if (part.state?.time?.start !== undefined) call.start = part.state.time.start;
        if (part.state?.time?.end !== undefined) call.end = part.state.time.end;
        calls.push(call);
      }
    }
  }
  return calls;
}

export function aggregate(
  sessions: SessionData[],
  roots: string[],
  mainAgent: string,
  permissions: PermissionRecord[] = [],
  questions: QuestionRecord[] = [],
): Metrics {
  const agents: Record<string, AgentMetrics> = {};
  const agentFor = (name: string) => (agents[name] ??= emptyAgent());
  const childSessions: Record<string, number> = {};
  const errors: string[] = [];
  let cost = 0;
  let tokens = emptyTokens();
  let requests = 0;

  for (const session of sessions) {
    const owner = sessionAgent(session);
    agentFor(owner).sessions++;
    if (!roots.includes(session.id)) childSessions[owner] = (childSessions[owner] ?? 0) + 1;
    for (const message of session.messages) {
      if (message.info.role !== "assistant") continue;
      const metrics = agentFor(messageAgent(message, owner));
      const messageCost = typeof message.info.cost === "number" && Number.isFinite(message.info.cost) ? message.info.cost : 0;
      metrics.cost += messageCost;
      cost += messageCost;
      const steps = message.parts.filter((part) => part.type === "step-finish");
      const perRequest = steps.length > 0 ? steps.map((part) => tokensOf(part.tokens)) : [tokensOf(message.info.tokens)];
      for (const used of perRequest) {
        if (steps.length === 0 && contextOf(used) + used.output + used.reasoning === 0) continue;
        metrics.tokens = addTokens(metrics.tokens, used);
        tokens = addTokens(tokens, used);
        metrics.requests++;
        requests++;
        metrics.peakContext = Math.max(metrics.peakContext, contextOf(used));
      }
      if (message.info.providerID && message.info.modelID) {
        const variant = message.info.variant ?? message.info.model?.variant;
        const model = `${message.info.providerID}/${message.info.modelID}${variant && variant !== "default" ? ` (${variant})` : ""}`;
        if (!metrics.models.includes(model)) metrics.models.push(model);
      }
      const error = errorText(message.info.error);
      if (error) errors.push(`${messageAgent(message, owner)}: ${error}`);
    }
  }

  const calls = toolCalls(sessions);
  for (const call of calls) {
    const metrics = agentFor(call.agent);
    metrics.toolCalls++;
    metrics.toolsByName[call.tool] = (metrics.toolsByName[call.tool] ?? 0) + 1;
    if (call.denied) metrics.deniedToolCalls++;
    if (call.command !== undefined) metrics.shellCommands.push(call.command);
  }
  for (const record of permissions) agentFor(record.agent).permissions++;
  for (const record of questions) agentFor(record.agent).questions++;

  return {
    cost,
    tokens,
    requests,
    mainAgent,
    mainPeakContext: agents[mainAgent]?.peakContext ?? 0,
    agents,
    childSessions,
    toolCalls: calls,
    errors,
  };
}

const LIMIT = 4_000;

function clip(text: string | undefined, limit = LIMIT): string | undefined {
  if (text === undefined) return undefined;
  return text.length <= limit ? text : `${text.slice(0, limit)}\n[... ${text.length - limit} more characters]`;
}

/** A readable transcript: every message and part, with long tool outputs shortened. */
export function transcript(sessions: SessionData[]): TranscriptSession[] {
  return sessions.map((session) => {
    const owner = sessionAgent(session);
    return {
      id: session.id,
      ...(session.parentID ? { parentID: session.parentID } : {}),
      ...(session.title ? { title: session.title } : {}),
      agent: owner,
      messages: session.messages.map((message) => {
        const model = message.info.providerID && message.info.modelID ? `${message.info.providerID}/${message.info.modelID}` : undefined;
        const error = errorText(message.info.error);
        return {
          role: message.info.role,
          agent: messageAgent(message, owner),
          ...(model ? { model } : {}),
          ...(message.info.role === "assistant" ? { cost: message.info.cost ?? 0 } : {}),
          ...(error ? { error } : {}),
          parts: message.parts
            .filter((part) => part.type !== "step-start")
            .map((part) => {
              switch (part.type) {
                case "text":
                case "reasoning":
                  return { type: part.type, text: clip(part.text, part.type === "reasoning" ? 2_000 : 20_000) ?? "" };
                case "tool":
                  return {
                    type: "tool",
                    tool: part.tool,
                    status: part.state?.status,
                    input: part.state?.input,
                    ...(part.state?.output !== undefined ? { output: clip(part.state.output) } : {}),
                    ...(part.state?.error !== undefined ? { error: clip(part.state.error) } : {}),
                  };
                case "subtask":
                  return { type: "subtask", agent: part.agent, text: clip(part.prompt) ?? "" };
                case "step-finish":
                  return { type: "step-finish", cost: part.cost ?? 0, tokens: tokensOf(part.tokens) };
                default:
                  return { type: part.type };
              }
            }),
        };
      }),
    };
  });
}
