// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { Compactions, isolateHelperRequest, type V1MessageWithParts } from "./isolate.ts";

const HELPERS = new Set(["scout", "builder", "reviewer"]);

function message(role: "user" | "assistant", agent: string | undefined, text = `${role} ${agent}`): V1MessageWithParts {
  return { info: { role, agent, sessionID: "ses_1" }, parts: [{ type: "text", text }] };
}

const texts = (messages: V1MessageWithParts[]) => messages.map((item) => (item.parts[0] as { text: string }).text);

describe("isolateHelperRequest", () => {
  test("in the user's session, a helper's request keeps only the request and the helper's own steps", () => {
    const messages = [
      message("user", "lead", "explain units"),
      message("assistant", "lead", "units are converted in units.py"),
      message("user", "reviewer", "review the changes"),
      message("assistant", "reviewer", "reading the diff"),
    ];
    expect(isolateHelperRequest(messages, HELPERS)).toBe(2);
    expect(texts(messages)).toEqual(["review the changes", "reading the diff"]);
  });

  test("a completion opencode wrote during an inline review is part of the review, not a new request", () => {
    const completion: V1MessageWithParts = { info: { role: "user", agent: "reviewer", sessionID: "ses_1" }, parts: [{ type: "text", text: "<task state=\"completed\">done</task>", synthetic: true }] };
    const messages = [message("user", "lead"), message("assistant", "lead"), message("user", "reviewer", "/review"), message("assistant", "reviewer", "step"), completion];
    expect(isolateHelperRequest(messages, HELPERS)).toBe(2);
    expect(texts(messages)).toEqual(["/review", "step", '<task state="completed">done</task>']);
    // Two reviews in a row stay apart: the second request is the second /review.
    const twice = [message("user", "lead"), message("user", "reviewer", "/review one"), message("assistant", "reviewer"), message("user", "reviewer", "/review two"), completion];
    expect(isolateHelperRequest(twice, HELPERS)).toBe(3);
    expect(texts(twice)).toEqual(["/review two", '<task state="completed">done</task>']);
  });

  test("lead's requests keep the whole conversation, reports included", () => {
    const messages = [
      message("user", "reviewer", "review the changes"),
      message("assistant", "reviewer", "VERDICT: REJECT"),
      message("user", "lead", "fix the blocker"),
    ];
    expect(isolateHelperRequest(messages, HELPERS)).toBe(0);
    expect(messages).toHaveLength(3);
  });

  test("a helper's own session is left alone, also when lead continues it with a further request", () => {
    const messages = [
      message("user", "builder", "brief"),
      message("assistant", "builder", "STATUS: PARTIAL"),
      message("user", "builder", "the gap is ..."),
    ];
    expect(isolateHelperRequest(messages, HELPERS)).toBe(0);
    expect(messages).toHaveLength(3);
  });

  test("a helper's first request in a session has nothing to drop", () => {
    const messages = [message("user", "reviewer")];
    expect(isolateHelperRequest(messages, HELPERS)).toBe(0);
    expect(isolateHelperRequest([], HELPERS)).toBe(0);
  });

  test("a second helper command after another helper's report drops that report too", () => {
    const messages = [
      message("user", "scout", "progress"),
      message("assistant", "scout", "2 of 5 done"),
      message("user", "reviewer", "review"),
    ];
    expect(isolateHelperRequest(messages, HELPERS)).toBe(2);
    expect(texts(messages)).toEqual(["review"]);
  });

  test("agents that are not helpers, and messages without an agent, are never trimmed for", () => {
    const build = [message("user", "lead"), message("assistant", "lead"), message("user", "build")];
    expect(isolateHelperRequest(build, HELPERS)).toBe(0);
    const unknown = [message("user", "lead"), message("user", undefined)];
    expect(isolateHelperRequest(unknown, HELPERS)).toBe(0);
  });

  test("earlier messages without an agent count as another agent's", () => {
    const messages = [message("user", undefined, "old"), message("user", "reviewer", "review")];
    expect(isolateHelperRequest(messages, HELPERS)).toBe(1);
    expect(texts(messages)).toEqual(["review"]);
  });

  test("changes the given array in place, as opencode keeps using it", () => {
    const messages = [message("user", "lead"), message("user", "scout")];
    const same = messages;
    isolateHelperRequest(messages, HELPERS);
    expect(same).toBe(messages);
    expect(same).toHaveLength(1);
  });
});

describe("Compactions", () => {
  test("a mark is taken once, by the next transform of that session", () => {
    const compactions = new Compactions(() => 1000);
    compactions.mark("ses_1");
    expect(compactions.take("ses_2")).toBe(false);
    expect(compactions.take("ses_1")).toBe(true);
    expect(compactions.take("ses_1")).toBe(false);
  });

  test("an old mark no longer counts", () => {
    let now = 0;
    const compactions = new Compactions(() => now);
    compactions.mark("ses_1");
    now = 61_000;
    expect(compactions.take("ses_1")).toBe(false);
  });

  test("ignores sessions that are not strings", () => {
    const compactions = new Compactions();
    compactions.mark(undefined);
    compactions.mark(42);
    expect(compactions.take(undefined)).toBe(false);
  });
});
