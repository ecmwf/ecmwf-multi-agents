// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

// Makes lead answer the user before it acts on a helper's report.
//
// A background helper's report reaches lead's session as a message of its own, `<subagent ...>`
// (core/src/session/subagent-completion.ts:36-43 at v2.0.16). When lead is still replying to the
// user, for example looking something up, the report joins the running turn at its next step
// (session/runner/llm.ts:165-177) as the newest message the model sees, and lead acts on it and
// forgets the user's question. Neither a rule in lead's prompt and the plan skill nor a note after
// the report changed that with a real model (evals/results/go-background.md). So lead is not
// shown such a report until it has answered.
//
// opencode 2 has no hook that can delay a message, so the `context` session hook, which sees each
// model request before it is sent (session/model-request.ts:378-385 at v2.0.16), leaves the report
// out of lead's requests until the reply ends, and the plugin queues a short message, delivered
// after the turn (`delivery: "queue"`, session/inbox.ts:43-48), that wakes lead to act on it.
//
// The rule: lead is replying when, walking back from the end of the conversation, a message from
// the user to lead comes before any step of lead's that ended a turn.

import type { V2ModelMessage } from "./types.ts";

/**
 * What a message is to the rule:
 * - request: a message from the user to lead; a reply to it is open until a step ends the turn.
 * - report: a background helper's report.
 * - ended: a step of lead's that ended a turn.
 * - boundary: a message to another agent, a summary of earlier conversation, or the wake below;
 *   no reply of lead's is open across it.
 * - other: anything else (a step that called tools, a note opencode wrote).
 */
export type Step = "request" | "report" | "ended" | "boundary" | "other";

/** Whether lead is replying to a request at the end of these steps. */
export function replyOpen(steps: readonly Step[]): boolean {
  for (let back = steps.length - 1; back >= 0; back--) {
    const step = steps[back];
    if (step === "request") return true;
    if (step === "ended" || step === "boundary") return false;
  }
  return false;
}

/** The positions of the reports that arrived while lead was replying to a request. */
export function earlyReports(steps: readonly Step[]): number[] {
  const early: number[] = [];
  steps.forEach((step, index) => {
    if (step === "report" && replyOpen(steps.slice(0, index))) early.push(index);
  });
  return early;
}

/** The reports that arrived while lead was replying, of a reply that has not ended yet. */
export function heldReports(steps: readonly Step[]): number[] {
  return earlyReports(steps).filter((index) => !steps.slice(index + 1).some((step) => step === "ended" || step === "boundary"));
}

/** The position of the request a reply answers, walking back from `index`. */
export function requestBefore(steps: readonly Step[], index: number): number {
  for (let back = index - 1; back >= 0; back--) if (steps[back] === "request") return back;
  return -1;
}

type Part = Record<string, unknown>;

function partsOf(parts: unknown): Part[] {
  return Array.isArray(parts) ? parts.filter((part): part is Part => part !== null && typeof part === "object") : [];
}

/** What wakes lead once its reply has ended, when it was shown none of the reports. */
export const WAKE_TEXT =
  "Reports from your helpers arrived while you were answering the user, so they were held back until you had answered. They are above: act on them now.";
/** How a background helper's report starts on opencode 2 (core/src/session/subagent-completion.ts). */
export const V2_REPORT_PREFIX = "<subagent ";
/** How opencode 2 starts the summary that replaces a compacted conversation. */
const V2_CHECKPOINT_PREFIX = "<conversation-checkpoint>";

function firstText(message: V2ModelMessage): string {
  const text = partsOf(message?.content).find((part) => part.type === "text")?.text;
  return typeof text === "string" ? text : "";
}

/** opencode 2: what each message of a model request is to the rule. */
export function stepsV2(messages: readonly V2ModelMessage[]): Step[] {
  return messages.map((message) => {
    if (message?.role === "user") {
      const text = firstText(message);
      if (text.startsWith(V2_REPORT_PREFIX)) return "report";
      if (text.startsWith(V2_CHECKPOINT_PREFIX) || text.startsWith(WAKE_TEXT)) return "boundary";
      return "request";
    }
    if (message?.role === "assistant") return partsOf(message.content).some((part) => part.type === "tool-call") ? "other" : "ended";
    return "other";
  });
}

/**
 * opencode 2: the reports to leave out of lead's request, and the key of the reply they belong
 * to (one wake per reply); undefined when none is held.
 */
export function heldReportsV2(messages: readonly V2ModelMessage[]): { held: number[]; reply: string } | undefined {
  const steps = stepsV2(messages);
  const held = heldReports(steps);
  if (held.length === 0) return undefined;
  const request = requestBefore(steps, held[0]!);
  return { held, reply: `${request}\n${request >= 0 ? firstText(messages[request]!) : ""}` };
}
