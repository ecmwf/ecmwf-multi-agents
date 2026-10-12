// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

// Keeps a helper that answers in the user's own session working from its request alone.
//
// On opencode 1.x, `/review` and `/progress` run their helper in the user's session instead of a
// child session (a command for a subagent with `subtask: false`, opencode/src/session/prompt.ts
// :1439-1458 at v1.18.35), so the report appears in the conversation and lead takes no extra turn
// to relay it. A model request in that session would normally carry the whole conversation. Before
// each request, opencode passes the messages to the `experimental.chat.messages.transform` hook
// (prompt.ts:1255) and sends what the hook leaves (prompt.ts:1257-1262), so this drops everything
// before the helper's request. The reviewer then stays independent of lead's reasoning, and a long
// session does not make a review expensive. Nothing is deleted: the stored conversation is
// unchanged, and lead sees all of it, the report included, on its next turn.
//
// Compaction also passes its messages through the same hook (opencode/src/session/compaction.ts
// :379), right after `experimental.session.compacting` (:373). Trimming there would leave the
// earlier conversation out of the summary, so a compaction in progress is never trimmed.

import { isSyntheticMessage } from "./inline.ts";

/** A stored message as the hook receives it: its info and its parts. */
export interface V1MessageWithParts {
  info: { role?: string; agent?: string; sessionID?: string };
  parts: unknown[];
}

/**
 * Drop the messages before a helper's request when the helper runs in a session that also holds
 * other agents' messages: the user's own session. Changes `messages` in place, because opencode
 * keeps using the same array, and returns the number of messages dropped.
 *
 * A session that holds only the helper's own messages (a child session, also one that lead
 * continues with a further request) is left alone.
 */
export function isolateHelperRequest(messages: V1MessageWithParts[], helpers: ReadonlySet<string>): number {
  // The request is the last user message the user or lead wrote. A completion opencode wrote
  // into the session meanwhile (docs/research/background-helpers.md, section 9) is part of the
  // helper's run, not a new request, so the helper keeps its brief and its steps.
  let request = -1;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.info?.role === "user" && !isSyntheticMessage(message.parts)) {
      request = index;
      break;
    }
  }
  if (request <= 0) return 0;
  const agent = messages[request]!.info.agent;
  if (agent === undefined || !helpers.has(agent)) return 0;
  const shared = messages.slice(0, request).some((message) => message?.info?.agent !== agent);
  if (!shared) return 0;
  messages.splice(0, request);
  return request;
}

/** How long a compaction mark lasts; compaction calls the hooks back to back. */
const COMPACTION_WINDOW_MS = 60_000;

/** Sessions with a compaction in progress, between the two hooks compaction calls. */
export class Compactions {
  private readonly started = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  mark(session: unknown): void {
    if (typeof session !== "string" || session === "") return;
    this.started.set(session, this.now());
    for (const [id, at] of this.started) if (this.now() - at > COMPACTION_WINDOW_MS) this.started.delete(id);
  }

  /** True once for a session marked within the window: that transform belongs to compaction. */
  take(session: unknown): boolean {
    if (typeof session !== "string") return false;
    const at = this.started.get(session);
    if (at === undefined) return false;
    this.started.delete(session);
    return this.now() - at <= COMPACTION_WINDOW_MS;
  }
}
