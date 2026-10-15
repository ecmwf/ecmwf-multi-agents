// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

// opencode 2 messages, shaped as opencode 2.0.28 returns them, converted for the metrics.

import { describe, expect, test } from "bun:test";
import { isCompletion } from "./checks.ts";
import { adaptMessages, initialAgent, type V2Message } from "./messages.ts";
import { aggregate, finalText } from "./metrics.ts";

const tokens = { input: 600, output: 50, reasoning: 0, cache: { read: 400, write: 0 } };
const model = { id: "m1", providerID: "mock" };

const root: V2Message[] = [
  { id: "msg_01", time: { created: 1 }, type: "user", text: "Find the range" },
  {
    id: "msg_02",
    time: { created: 2, completed: 3 },
    type: "assistant",
    agent: "lead",
    model,
    content: [
      {
        type: "tool",
        id: "call_1",
        name: "subagent",
        state: { status: "completed", input: { agent: "scout", description: "find range", prompt: "where?", background: true }, content: [{ type: "text", text: "started" }], metadata: { sessionID: "ses_child" } },
        time: { created: 2, ran: 2, completed: 3 },
      },
    ],
    finish: "tool-calls",
    cost: 0.00267,
    tokens,
  },
  { id: "msg_03", time: { created: 4, completed: 5 }, type: "assistant", agent: "lead", model, content: [{ type: "text", text: "lead handed off" }], cost: 0.00267, tokens },
  { id: "msg_04", time: { created: 6 }, type: "idle", outcome: "succeeded" },
  {
    id: "msg_05",
    time: { created: 7 },
    type: "synthetic",
    metadata: { source: "subagent", childID: "ses_child", agent: "scout", state: "completed" },
    text: '<subagent sessionID="ses_child" state="completed" description="find range">\nANSWER: -90 to 60\n</subagent>',
  },
  { id: "msg_06", time: { created: 8, completed: 9 }, type: "assistant", agent: "lead", model: { ...model, variant: "high" }, content: [{ type: "reasoning", text: "think" }, { type: "text", text: "Valid: -90 to 60." }], cost: 0.00267, tokens },
  { id: "msg_07", time: { created: 10 }, type: "idle", outcome: "succeeded" },
];

describe("adaptMessages", () => {
  const messages = adaptMessages("ses_root", root, "lead");

  test("user and completion messages carry the session's agent; idle markers are left out", () => {
    expect(messages.map((message) => `${message.info.role}:${message.info.agent}`)).toEqual(["user:lead", "assistant:lead", "assistant:lead", "user:lead", "assistant:lead"]);
    expect(messages[0]!.parts).toEqual([{ type: "text", text: "Find the range" }]);
  });

  test("a background completion is a synthetic user message", () => {
    expect(messages[3]!.parts[0]).toMatchObject({ type: "text", synthetic: true });
    expect(isCompletion(messages[3]!)).toBe(true);
    expect(isCompletion(messages[0]!)).toBe(false);
  });

  test("each assistant message is one request with a step-finish part, model and variant", () => {
    expect(messages[4]!.info).toMatchObject({ role: "assistant", providerID: "mock", modelID: "m1", variant: "high", cost: 0.00267, time: { created: 8, completed: 9 } });
    expect(messages[4]!.parts.map((part) => part.type)).toEqual(["reasoning", "text", "step-finish"]);
    expect(messages[4]!.parts.at(-1)).toEqual({ type: "step-finish", cost: 0.00267, tokens });
  });

  test("tool parts keep the name, input, output text and times", () => {
    expect(messages[1]!.parts[0]).toEqual({
      id: "call_1",
      type: "tool",
      tool: "subagent",
      callID: "call_1",
      state: { status: "completed", input: { agent: "scout", description: "find range", prompt: "where?", background: true }, output: "started", metadata: { sessionID: "ses_child" }, time: { start: 2, end: 3 } },
    });
  });

  test("metrics over converted messages: one request per step", () => {
    const metrics = aggregate([{ id: "ses_root", agent: "lead", messages }], ["ses_root"], "lead");
    expect(metrics.agents.lead!.requests).toBe(3);
    expect(metrics.agents.lead!.tokens).toEqual({ input: 1800, output: 150, reasoning: 0, cacheRead: 1200, cacheWrite: 0 });
    expect(metrics.agents.lead!.models).toEqual(["mock/m1", "mock/m1 (high)"]);
    expect(metrics.agents.lead!.toolsByName).toEqual({ subagent: 1 });
    expect(finalText({ messages })).toBe("Valid: -90 to 60.");
  });

  test("a refused tool call: the denial is kept, the aborted step error is not an error", () => {
    const refused = adaptMessages("s", [
      { id: "msg_1", type: "user", text: "push" },
      {
        id: "msg_2",
        type: "assistant",
        agent: "lead",
        model,
        content: [{ type: "tool", id: "call_2", name: "shell", state: { status: "error", input: { command: "git push origin main" }, error: { type: "aborted", message: "The user declined this tool call" } }, time: { created: 1, ran: 2, completed: 3 } }],
        finish: "error",
        cost: 0.001,
        tokens,
        error: { type: "aborted", message: "Step interrupted" },
      },
    ]);
    expect(refused[1]!.info.error).toBeUndefined();
    const metrics = aggregate([{ id: "s", messages: refused }], ["s"], "lead");
    expect(metrics.errors).toEqual([]);
    expect(metrics.toolCalls[0]).toMatchObject({ tool: "shell", command: "git push origin main", status: "error", denied: "user", start: 2, end: 3 });
  });

  test("other step errors are kept", () => {
    const failed = adaptMessages("s", [{ id: "msg_1", type: "assistant", agent: "lead", model, content: [], error: { type: "provider.auth", message: "expired" } }]);
    expect(failed[0]!.info.error).toEqual({ type: "provider.auth", message: "expired" });
  });
});

describe("agents", () => {
  test("agent switches change the agent of later user messages", () => {
    const messages = adaptMessages(
      "s",
      [
        { id: "msg_1", type: "user", text: "a" },
        { id: "msg_2", type: "agent-switched", agent: "build", previous: "lead" },
        { id: "msg_3", type: "user", text: "b" },
      ],
      "build",
    );
    expect(messages.map((message) => message.info.agent)).toEqual(["lead", "build"]);
  });

  test("the first agent: before the first switch, else the session's", () => {
    expect(initialAgent([], "scout")).toBe("scout");
    expect(initialAgent([{ id: "1", type: "agent-switched", agent: "lead" }, { id: "2", type: "user" }], undefined)).toBe("lead");
    expect(initialAgent([{ id: "1", type: "user" }, { id: "2", type: "agent-switched", agent: "build" }], "build")).toBe("build");
  });

  test("compaction requests count, under their own name", () => {
    const messages = adaptMessages("s", [{ id: "msg_1", type: "compaction", status: "completed", cost: 0.5, tokens }]);
    expect(messages[0]!.info).toMatchObject({ role: "assistant", agent: "compaction", cost: 0.5 });
    expect(adaptMessages("s", [{ id: "msg_1", type: "compaction", status: "running" }])).toEqual([]);
  });
});
