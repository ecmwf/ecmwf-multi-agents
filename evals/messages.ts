// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

// Converts opencode 2 session messages into the shape the metrics and checks read: one
// ApiMessage per user, completion or assistant message, with parts.
//
// opencode 2 keeps one assistant message per model request (step), with its own cost and
// tokens. Each converted assistant message gets one step-finish part carrying them, so a
// request is counted once. User messages carry no agent: the agent comes from the session and
// from agent-switched messages. A background helper's completion is a synthetic message whose
// text starts `<subagent `; it becomes a user message with a synthetic text part.

import type { ApiMessage, ApiPart, ApiTokens } from "./types.ts";

export interface V2Error {
  type?: string;
  message?: string;
}

export interface V2ToolPart {
  type: "tool";
  id: string;
  name: string;
  state: {
    status: string;
    input?: unknown;
    content?: Array<{ type: string; text?: string }>;
    error?: V2Error;
    metadata?: Record<string, unknown>;
  };
  time?: { created?: number; ran?: number; completed?: number };
}

export type V2Content = { type: "text"; text: string } | { type: "reasoning"; text: string } | V2ToolPart;

/** One opencode 2 session message, reduced to the fields the evals read. */
export interface V2Message {
  id: string;
  type: string;
  time?: { created?: number; completed?: number };
  metadata?: Record<string, unknown>;
  text?: string;
  agent?: string;
  previous?: string;
  model?: { id?: string; providerID?: string; variant?: string };
  content?: V2Content[];
  cost?: number;
  tokens?: ApiTokens;
  error?: V2Error;
  finish?: string;
  outcome?: string;
  status?: string;
}

/** Errors that only say a step or tool call was stopped, by a refusal or an interrupt. */
export function isAborted(error: V2Error | undefined): boolean {
  return error?.type === "aborted";
}

/** The agent a session started with: before its first switch, else the session's agent. */
export function initialAgent(messages: V2Message[], sessionAgent: string | undefined): string | undefined {
  const firstUser = messages.findIndex((message) => message.type === "user" || message.type === "synthetic");
  const firstSwitch = messages.findIndex((message) => message.type === "agent-switched");
  if (firstSwitch === -1) return sessionAgent;
  const switched = messages[firstSwitch]!;
  if (switched.previous) return switched.previous;
  return firstUser === -1 || firstSwitch < firstUser ? switched.agent : sessionAgent;
}

function contentText(content: V2ToolPart["state"]["content"]): string | undefined {
  if (!content) return undefined;
  return content
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text!)
    .join("\n");
}

function toolPart(part: V2ToolPart): ApiPart {
  const input = part.state.input && typeof part.state.input === "object" ? (part.state.input as Record<string, unknown>) : {};
  const output = contentText(part.state.content);
  const start = part.time?.ran ?? part.time?.created;
  return {
    id: part.id,
    type: "tool",
    tool: part.name,
    callID: part.id,
    state: {
      status: part.state.status,
      input,
      ...(output !== undefined ? { output } : {}),
      ...(part.state.error?.message !== undefined ? { error: part.state.error.message } : {}),
      ...(part.state.error?.type !== undefined ? { errorType: part.state.error.type } : {}),
      ...(part.state.metadata ? { metadata: part.state.metadata } : {}),
      time: { ...(start !== undefined ? { start } : {}), ...(part.time?.completed !== undefined ? { end: part.time.completed } : {}) },
    },
  };
}

/** The messages of one session, oldest first, in the shape of ApiMessage. */
export function adaptMessages(sessionID: string, messages: V2Message[], sessionAgent?: string): ApiMessage[] {
  const out: ApiMessage[] = [];
  let agent = initialAgent(messages, sessionAgent);
  for (const message of messages) {
    const time = { ...(message.time?.created !== undefined ? { created: message.time.created } : {}), ...(message.time?.completed !== undefined ? { completed: message.time.completed } : {}) };
    switch (message.type) {
      case "agent-switched":
        if (message.agent) agent = message.agent;
        break;
      case "user":
        out.push({ info: { id: message.id, sessionID, role: "user", ...(agent ? { agent } : {}), time }, parts: [{ type: "text", text: message.text ?? "" }] });
        break;
      case "synthetic":
        out.push({
          info: { id: message.id, sessionID, role: "user", ...(agent ? { agent } : {}), time, ...(message.metadata ? { metadata: message.metadata } : {}) },
          parts: [{ type: "text", text: message.text ?? "", synthetic: true }],
        });
        break;
      case "assistant":
      case "compaction": {
        if (message.type === "compaction" && message.cost === undefined && message.tokens === undefined) break;
        const owner = message.type === "compaction" ? "compaction" : (message.agent ?? agent);
        const parts: ApiPart[] = [];
        for (const part of message.content ?? []) {
          if (part.type === "tool") parts.push(toolPart(part));
          else if (part.type === "text" || part.type === "reasoning") parts.push({ type: part.type, text: part.text });
        }
        parts.push({ type: "step-finish", cost: message.cost ?? 0, tokens: message.tokens ?? {} });
        out.push({
          info: {
            id: message.id,
            sessionID,
            role: "assistant",
            ...(owner ? { agent: owner } : {}),
            ...(message.model?.providerID ? { providerID: message.model.providerID } : {}),
            ...(message.model?.id ? { modelID: message.model.id } : {}),
            ...(message.model?.variant ? { variant: message.model.variant } : {}),
            cost: message.cost ?? 0,
            ...(message.tokens ? { tokens: message.tokens } : {}),
            time,
            ...(message.error && !isAborted(message.error) ? { error: message.error } : {}),
            ...(message.finish ? { finish: message.finish } : {}),
          },
          parts,
        });
        break;
      }
      default:
        // Idle markers, model and location switches, system updates: not part of the transcript.
        break;
    }
  }
  return out;
}
