// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { earlyReports, heldReports, heldReportsV2, replyOpen, requestBefore, stepsV2, WAKE_TEXT } from "./answer-first.ts";
import type { V2ModelMessage } from "./types.ts";

describe("the rule", () => {
  test("lead is replying while a request has had no step that ended the turn", () => {
    expect(replyOpen(["request"])).toBe(true);
    expect(replyOpen(["request", "other", "report", "other"])).toBe(true);
    expect(replyOpen(["request", "ended"])).toBe(false);
    expect(replyOpen(["request", "ended", "report", "other"])).toBe(false);
    expect(replyOpen(["boundary", "other"])).toBe(false);
    expect(replyOpen([])).toBe(false);
  });

  test("a report is early when lead was replying as it arrived; a later request reopens a reply", () => {
    expect(earlyReports(["request", "other", "report", "other", "report"])).toEqual([2, 4]);
    expect(earlyReports(["request", "ended", "report", "other", "report"])).toEqual([]);
    expect(earlyReports(["request", "ended", "report", "ended", "request", "other", "report"])).toEqual([6]);
  });

  test("an early report is held until a step ends the reply or a boundary comes", () => {
    expect(heldReports(["request", "other", "report", "other"])).toEqual([2]);
    expect(heldReports(["request", "other", "report", "other", "request", "other"])).toEqual([2]);
    expect(heldReports(["request", "other", "report", "ended"])).toEqual([]);
    expect(heldReports(["request", "other", "report", "ended", "boundary"])).toEqual([]);
    expect(heldReports(["request", "other", "report", "boundary", "report", "other"])).toEqual([]);
  });

  test("the request a report interrupted is the one before it", () => {
    expect(requestBefore(["request", "ended", "request", "other", "report"], 4)).toBe(2);
    expect(requestBefore(["report"], 0)).toBe(-1);
  });
});

describe("heldReportsV2", () => {
  const user = (text: string): V2ModelMessage => ({ role: "user", content: [{ type: "text", text }] });
  const report = () => user('<subagent sessionID="ses_c" state="completed" description="T1">\nSTATUS: DONE\n</subagent>');
  const lookup = (): V2ModelMessage => ({ role: "assistant", content: [{ type: "tool-call", id: "call_1", name: "read", input: {} }] });
  const result = (): V2ModelMessage => ({ role: "tool", content: [{ type: "tool-result", id: "call_1", name: "read", result: { type: "text", value: "MIN = -90" } }] });
  const answer = (): V2ModelMessage => ({ role: "assistant", content: [{ type: "text", text: "From -90 to 60 degrees Celsius." }] });

  test("a report that arrives while lead looks up the answer is held, with the reply it interrupted", () => {
    const messages = [user("/execute json-output"), answer(), user("What range?"), lookup(), result(), report()];
    expect(heldReportsV2(messages)).toEqual({ held: [5], reply: "2\nWhat range?" });
    // Every request of the same reply names the same reply: one wake per reply.
    expect(heldReportsV2([...messages, lookup(), result(), report()])).toEqual({ held: [5, 8], reply: "2\nWhat range?" });
  });

  test("once the reply has ended, and when the wake has come, the report is in view again; a report after the wake is never held", () => {
    expect(heldReportsV2([user("What range?"), lookup(), result(), report(), answer()])).toBeUndefined();
    expect(heldReportsV2([user("What range?"), lookup(), result(), report(), answer(), user(WAKE_TEXT)])).toBeUndefined();
    expect(heldReportsV2([user("What range?"), lookup(), result(), report(), user(WAKE_TEXT), lookup(), report()])).toBeUndefined();
  });

  test("a report that wakes lead, or follows a compaction checkpoint, is not held", () => {
    expect(heldReportsV2([user("What range?"), answer(), report(), lookup(), result(), report()])).toBeUndefined();
    expect(heldReportsV2([user("<conversation-checkpoint>\nsummary\n</conversation-checkpoint>"), report()])).toBeUndefined();
  });

  test("each message of a request is classified as opencode sends it", () => {
    const checkpoint = user("<conversation-checkpoint>\nsummary\n</conversation-checkpoint>");
    expect(stepsV2([user("q"), lookup(), result(), report(), answer(), user(WAKE_TEXT), checkpoint])).toEqual(["request", "other", "other", "report", "ended", "boundary", "boundary"]);
  });
});
