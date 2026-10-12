// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

// On opencode 1.x, `/review` and `/progress` answer in the user's own session as the command's
// agent (`subtask: false`), so the report appears in the conversation and lead takes no extra turn
// to relay it. Sharing the session with a helper can go wrong in two ways, and this module decides
// what the plugin does about each (line numbers are opencode 1.18.35, identical in 1.19.0):
//
// 1. The session loop runs the agent of its newest user message (opencode/src/session/prompt.ts
//    :1096 and :1170; `latest()` orders messages by creation time, session/message-v2.ts:595-616).
//    A helper command sent while another agent works would take over that agent's run, and lead
//    would never see the result it was waiting for. Such a command is turned into the form opencode
//    gives a command that runs in a child session (prompt.ts:1439-1453): one subtask part, on a
//    message of the agent that was working. The loop runs the subtask after the current step, then
//    tells that agent to go on (prompt.ts:430-448), as every helper command did before 0.2.0.
// 2. A background helper's completion is written as the agent the session record names
//    (opencode/src/tool/task.ts:227-253), and after an inline command that is the helper. The helper
//    would answer it, and lead would never be woken. The completion is given back to the session's
//    owner: the agent that works in it, normally lead.
//
// Neither may cut short a helper that is answering inline: a helper command or a completion that
// arrives meanwhile waits in the `chat.message` hook until the session is idle. The hook runs
// before opencode saves the message (prompt.ts:999-1047), and nothing else waits for it: each hook
// call runs on its own (opencode/src/plugin/index.ts:284-297), a completion is created in a fiber of
// its own (task.ts:253), and a command's request returns only when its run ends anyway. A message
// that waited is dated when it is delivered, so it is the newest one when the loop looks.

import { pinMessage, remember } from "./helpers.ts";
import type { V1ModelRef, V1UserMessage } from "./types.ts";

/** How a background helper's completion starts (opencode/src/tool/task.ts:64-79). */
export const COMPLETION_PREFIX = "<task ";
/** How long a message waits for a helper that answers inline. */
export const INLINE_WAIT_LIMIT_MS = 30 * 60_000;
/** How long a slash command's name is kept for the message it is about to create. */
const PENDING_MS = 60_000;

type Part = Record<string, unknown>;

function textParts(parts: unknown): Part[] {
  if (!Array.isArray(parts)) return [];
  return parts.filter((part): part is Part => part !== null && typeof part === "object" && (part as Part).type === "text");
}

/** True when opencode wrote every text part of a message itself (a completion, a "continue" note). */
export function isSyntheticMessage(parts: unknown): boolean {
  const texts = textParts(parts);
  return texts.length > 0 && texts.every((part) => part.synthetic === true);
}

/** True for a background helper's completion: a message opencode wrote itself, as `<task ...>`. */
export function isCompletion(parts: unknown): boolean {
  const first = textParts(parts)[0]?.text;
  return isSyntheticMessage(parts) && typeof first === "string" && first.startsWith(COMPLETION_PREFIX);
}

/**
 * What to do with a message that lands in the user's own session:
 * - leave: not a helper's message, or the session's state cannot be read; opencode's way stands.
 * - inline: a helper command in an idle session; it answers there.
 * - subtask: a helper command while another agent works; it runs in a child session instead.
 * - owner: a completion; it goes to the session's owner.
 * - wait: a helper is answering inline; decide again once the session is idle.
 */
export type InlineAction = "leave" | "inline" | "subtask" | "owner" | "wait";

export interface InlineFacts {
  /** The agent the message names. */
  agent: string | undefined;
  completion: boolean;
  /** Whether the session has work in progress; undefined when it cannot be read. */
  busy: boolean | undefined;
  /** The agent last seen working in the session. */
  running: string | undefined;
}

export function inlineAction(facts: InlineFacts, helpers: ReadonlySet<string>): InlineAction {
  if (facts.agent === undefined || !helpers.has(facts.agent) || facts.busy === undefined) return "leave";
  if (facts.busy && facts.running !== undefined && helpers.has(facts.running)) return "wait";
  if (facts.completion) return "owner";
  return facts.busy ? "subtask" : "inline";
}

export interface SubtaskSpec {
  agent: string;
  description: string;
  command?: string;
  model?: { providerID: string; modelID: string };
}

/**
 * Turn the parts of a helper command's message into one subtask part with the command's text as
 * its prompt, as opencode builds a command that runs in a child session (prompt.ts:1440-1451; the
 * part's schema is schema/src/v1/session.ts:204-217). The subtask takes the ids of the first text
 * part. Changes `parts` in place, because opencode saves that array; returns false and changes
 * nothing when there is no text to run.
 */
export function toSubtask(parts: unknown[], spec: SubtaskSpec): boolean {
  const first = textParts(parts)[0];
  if (first === undefined || typeof first.text !== "string" || first.text.trim() === "") return false;
  const subtask: Part = {
    ...(first.id !== undefined ? { id: first.id } : {}),
    ...(first.sessionID !== undefined ? { sessionID: first.sessionID } : {}),
    ...(first.messageID !== undefined ? { messageID: first.messageID } : {}),
    type: "subtask",
    prompt: first.text,
    description: spec.description,
    agent: spec.agent,
    ...(spec.model !== undefined ? { model: { providerID: spec.model.providerID, modelID: spec.model.modelID } } : {}),
    ...(spec.command !== undefined ? { command: spec.command } : {}),
  };
  parts.splice(0, parts.length, subtask);
  return true;
}

/** The agent that works in a session, and the model of its latest request when known. */
export interface Owner {
  agent: string;
  model?: V1ModelRef;
}

/**
 * Make a message the owner's: its agent, and the model it works with. Without a known model the
 * owner's own model and effort from the settings apply when it has one; otherwise the message keeps
 * the model opencode gave it, which is the session's.
 */
export function giveTo(message: V1UserMessage, owner: Owner, plan: { model?: string; effort?: string } | undefined): void {
  const model = owner.model;
  if (typeof model?.providerID === "string" && typeof model.modelID === "string") {
    message.agent = owner.agent;
    message.model = { providerID: model.providerID, modelID: model.modelID, ...(typeof model.variant === "string" ? { variant: model.variant } : {}) };
    return;
  }
  pinMessage(message, owner.agent, plan);
}

/** The owner of each session, from the requests of agents that are not helpers. */
export class Owners {
  private readonly owners = new Map<string, Owner>();

  note(session: unknown, agent: unknown, model: unknown): void {
    if (typeof session !== "string" || session === "" || typeof agent !== "string" || agent === "") return;
    const ref = model !== null && typeof model === "object" ? (model as V1ModelRef) : undefined;
    remember(this.owners, session, { agent, ...(ref !== undefined ? { model: { ...ref } } : {}) });
  }

  get(session: string): Owner | undefined {
    return this.owners.get(session);
  }
}

/** The slash command each session is about to create a message for (`command.execute.before`). */
export class PendingCommands {
  private readonly pending = new Map<string, { command: string; at: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  note(session: unknown, command: unknown): void {
    if (typeof session !== "string" || session === "" || typeof command !== "string" || command === "") return;
    remember(this.pending, session, { command, at: this.now() }, 1000);
  }

  /** The command, once, if it was noted for this session in the last minute. */
  take(session: string): string | undefined {
    const entry = this.pending.get(session);
    this.pending.delete(session);
    return entry !== undefined && this.now() - entry.at <= PENDING_MS ? entry.command : undefined;
  }
}

export interface WaitOptions {
  limitMs: number;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

/**
 * Poll until the session is idle. Returns false once it is; true when it is still busy at the
 * limit; undefined when its state could not be read three times in a row.
 */
export async function waitForIdle(busy: () => Promise<boolean | undefined>, options: WaitOptions): Promise<boolean | undefined> {
  const deadline = options.now() + options.limitMs;
  let unreadable = 0;
  let pause = 200;
  for (;;) {
    const state = await busy();
    if (state === false) return false;
    unreadable = state === undefined ? unreadable + 1 : 0;
    if (unreadable >= 3 || options.now() >= deadline) return state;
    await options.sleep(pause);
    pause = Math.min(pause * 2, 1000);
  }
}

/** A pause that does not keep the process alive. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    (timer as { unref?: () => void }).unref?.();
  });
}
