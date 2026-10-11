// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { aggregate, classifyDenial, errorText, finalText, sessionAgent, tokensOf, transcript } from "./metrics.ts";
import type { ApiMessage, ApiPart, SessionData } from "./types.ts";

const step = (input: number, output: number, read = 0, write = 0, reasoning = 0, cost = 0): ApiPart => ({
  type: "step-finish",
  cost,
  tokens: { input, output, reasoning, cache: { read, write } },
});

const user = (sessionID: string, agent: string, text: string): ApiMessage => ({
  info: { id: `u-${sessionID}`, sessionID, role: "user", agent, model: { providerID: "anthropic", modelID: "m" } },
  parts: [{ type: "text", text }],
});

const assistant = (sessionID: string, agent: string, cost: number, parts: ApiPart[], extra: Partial<ApiMessage["info"]> = {}): ApiMessage => ({
  info: { id: `a-${sessionID}-${cost}`, sessionID, role: "assistant", agent, mode: agent, providerID: "anthropic", modelID: "opus", cost, tokens: { input: 1, output: 1 }, ...extra },
  parts,
});

const tool = (name: string, status: string, input: Record<string, unknown>, error?: string): ApiPart => ({
  type: "tool",
  tool: name,
  callID: `c-${name}-${status}`,
  state: { status, input, ...(error ? { error } : {}), time: { start: 10, end: 20 } },
});

function run(): SessionData[] {
  return [
    {
      id: "root",
      messages: [
        user("root", "lead", "question"),
        assistant(
          "root",
          "lead",
          0.3,
          [
            tool("task", "completed", { subagent_type: "scout", prompt: "find it" }),
            step(100, 20, 1000, 500, 5, 0.1),
            { type: "text", text: "Here is the answer." },
            { type: "text", text: "internal", synthetic: true },
            step(50, 10, 3000, 0, 0, 0.2),
          ],
          { variant: "xhigh" },
        ),
      ],
    },
    {
      id: "child-1",
      parentID: "root",
      messages: [
        user("child-1", "scout", "find it"),
        assistant("child-1", "scout", 0.05, [
          tool("bash", "completed", { command: "git log -1" }),
          tool("bash", "error", { command: "rm -rf x" }, "The user has specified a rule which prevents you from using this specific tool call. Here are some of the relevant rules []"),
          tool("bash", "error", { command: "git push" }, 'ecmwf-multi-agents: helpers may not run "git push"; lead handles git and GitHub.'),
          step(10, 5, 200, 0, 0, 0.05),
          { type: "text", text: "ANSWER: found" },
        ]),
      ],
    },
    {
      id: "child-2",
      parentID: "root",
      messages: [user("child-2", "scout", "again"), assistant("child-2", "scout", 0.01, [step(1, 1), { type: "text", text: "ANSWER: again" }], { error: { name: "ProviderAuthError", data: { message: "expired" } } })],
    },
  ];
}

describe("aggregate", () => {
  const metrics = aggregate(
    run(),
    ["root"],
    "lead",
    [{ id: "p1", sessionID: "root", agent: "lead", permission: "bash", patterns: ["git push"], reply: "reject", reason: "push", at: 1 }],
    [{ id: "q1", sessionID: "root", agent: "lead", questions: [{ question: "q", options: ["a"] }], answers: [["a"]], at: 1 }],
  );

  test("cost comes from messages and tokens from each request", () => {
    expect(metrics.cost).toBeCloseTo(0.36);
    expect(metrics.agents.lead!.cost).toBeCloseTo(0.3);
    expect(metrics.agents.scout!.cost).toBeCloseTo(0.06);
    expect(metrics.agents.lead!.tokens).toEqual({ input: 150, output: 30, reasoning: 5, cacheRead: 4000, cacheWrite: 500 });
    expect(metrics.agents.lead!.requests).toBe(2);
    expect(metrics.requests).toBe(4);
    expect(metrics.tokens.input).toBe(161);
  });

  test("peak context is the largest single request of the main agent", () => {
    expect(metrics.mainAgent).toBe("lead");
    expect(metrics.mainPeakContext).toBe(3050);
    expect(metrics.agents.scout!.peakContext).toBe(210);
  });

  test("models, sessions, child sessions and errors per agent", () => {
    expect(metrics.agents.lead!.models).toEqual(["anthropic/opus (xhigh)"]);
    expect(metrics.agents.scout!.models).toEqual(["anthropic/opus"]);
    expect(metrics.agents.lead!.sessions).toBe(1);
    expect(metrics.agents.scout!.sessions).toBe(2);
    expect(metrics.childSessions).toEqual({ scout: 2 });
    expect(metrics.errors).toEqual(["scout: ProviderAuthError: expired"]);
  });

  test("tool calls, denials, shell commands, questions and permissions per agent", () => {
    expect(metrics.agents.lead!.toolCalls).toBe(1);
    expect(metrics.agents.lead!.toolsByName).toEqual({ task: 1 });
    expect(metrics.agents.scout!.toolCalls).toBe(3);
    expect(metrics.agents.scout!.deniedToolCalls).toBe(2);
    expect(metrics.agents.scout!.shellCommands).toEqual(["git log -1", "rm -rf x", "git push"]);
    expect(metrics.toolCalls.map((call) => call.denied)).toEqual([undefined, undefined, "rule", "guard"]);
    expect(metrics.toolCalls[1]).toMatchObject({ sessionID: "child-1", agent: "scout", command: "git log -1", start: 10, end: 20 });
    expect(metrics.agents.lead!.questions).toBe(1);
    expect(metrics.agents.lead!.permissions).toBe(1);
  });

  test("a message without step parts counts its own tokens once", () => {
    const only = aggregate([{ id: "s", messages: [assistant("s", "build", 0.5, [], { tokens: { input: 7, output: 3, cache: { read: 90 } } })] }], ["s"], "build");
    expect(only.tokens).toEqual({ input: 7, output: 3, reasoning: 0, cacheRead: 90, cacheWrite: 0 });
    expect(only.requests).toBe(1);
    expect(only.mainPeakContext).toBe(97);
    expect(aggregate([], [], "lead").cost).toBe(0);
  });
});

describe("helpers", () => {
  test("session agent from the first user message, else the assistant", () => {
    expect(sessionAgent(run()[1]!)).toBe("scout");
    expect(sessionAgent({ messages: [assistant("x", "reviewer", 0, [])] })).toBe("reviewer");
    expect(sessionAgent({ messages: [] })).toBe("unknown");
  });

  test("final text skips synthetic parts and empty assistant messages", () => {
    const session = run()[0]!;
    session.messages.push(assistant("root", "lead", 0, [step(1, 1)]));
    expect(finalText(session)).toBe("Here is the answer.");
    expect(finalText({ messages: [] })).toBe("");
  });

  test("denials are told apart from ordinary errors", () => {
    expect(classifyDenial("The user rejected permission to use this specific tool call.")).toBe("user");
    expect(classifyDenial("The user rejected permission to use this specific tool call with the following feedback: no")).toBe("user");
    expect(classifyDenial("Error: command not found")).toBeUndefined();
    expect(classifyDenial(undefined)).toBeUndefined();
  });

  test("tokens and errors from loose input", () => {
    expect(tokensOf(undefined)).toEqual({ input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 });
    expect(tokensOf({ input: Number.NaN, output: 2 })).toMatchObject({ input: 0, output: 2 });
    expect(errorText({ name: "MessageAbortedError" })).toBe("MessageAbortedError");
    expect(errorText("plain")).toBe("plain");
    expect(errorText(undefined)).toBe("");
  });

  test("the transcript keeps every message and shortens long tool output", () => {
    const sessions = run();
    (sessions[1]!.messages[1]!.parts[0]!.state as { output?: string }).output = "x".repeat(10_000);
    const result = transcript(sessions);
    expect(result.map((session) => session.agent)).toEqual(["lead", "scout", "scout"]);
    expect(result[1]!.parentID).toBe("root");
    const output = result[1]!.messages[1]!.parts[0]!.output!;
    expect(output.length).toBeLessThan(4_100);
    expect(output).toContain("more characters");
    expect(result[0]!.messages[1]!.parts.find((part) => part.type === "step-finish")).toEqual({ type: "step-finish", cost: 0.1, tokens: { input: 100, output: 20, reasoning: 5, cacheRead: 1000, cacheWrite: 500 } });
    expect(result[2]!.messages[1]!.error).toBe("ProviderAuthError: expired");
  });
});
