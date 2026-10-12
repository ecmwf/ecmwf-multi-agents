// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { Owners, PendingCommands, giveTo, inlineAction, isCompletion, isSyntheticMessage, toSubtask, waitForIdle, type InlineFacts } from "./inline.ts";
import type { V1UserMessage } from "./types.ts";

const HELPERS = new Set(["scout", "builder", "reviewer"]);
const COMPLETION = [{ type: "text", synthetic: true, text: '<task id="ses_child" state="completed">\n<task_result>\ndone\n</task_result>\n</task>' }];

describe("message kinds", () => {
  test("a completion is a message opencode wrote itself as <task ...>", () => {
    expect(isCompletion(COMPLETION)).toBe(true);
    expect(isCompletion([{ ...COMPLETION[0], text: COMPLETION[0]!.text.replace("completed", "error") }])).toBe(true);
    // A user's text, a "continue" note, and a mix with the user's own text are not.
    expect(isCompletion([{ type: "text", text: '<task id="x">' }])).toBe(false);
    expect(isCompletion([{ type: "text", synthetic: true, text: "Summarize the task tool output above and continue with your task." }])).toBe(false);
    expect(isCompletion([...COMPLETION, { type: "text", text: "and also this" }])).toBe(false);
    expect(isCompletion([])).toBe(false);
    expect(isCompletion(undefined)).toBe(false);
  });

  test("a synthetic message has text parts, all of them written by opencode", () => {
    expect(isSyntheticMessage(COMPLETION)).toBe(true);
    expect(isSyntheticMessage([{ type: "text", synthetic: true, text: "editor context" }, { type: "text", text: "my question" }])).toBe(false);
    expect(isSyntheticMessage([{ type: "file", url: "file:///x" }])).toBe(false);
    expect(isSyntheticMessage(null)).toBe(false);
  });
});

describe("inlineAction", () => {
  const facts = (overrides: Partial<InlineFacts>): InlineFacts => ({ agent: "reviewer", completion: false, busy: false, running: "lead", ...overrides });

  test("a helper command answers inline in an idle session, and runs in a child session while another agent works", () => {
    expect(inlineAction(facts({ busy: false }), HELPERS)).toBe("inline");
    expect(inlineAction(facts({ busy: true, running: "lead" }), HELPERS)).toBe("subtask");
    expect(inlineAction(facts({ busy: true, running: "build" }), HELPERS)).toBe("subtask");
    expect(inlineAction(facts({ busy: true, running: undefined }), HELPERS)).toBe("subtask");
  });

  test("a completion goes to the owner, idle or while the owner works", () => {
    expect(inlineAction(facts({ completion: true, busy: false }), HELPERS)).toBe("owner");
    expect(inlineAction(facts({ completion: true, busy: true, running: "lead" }), HELPERS)).toBe("owner");
  });

  test("a helper answering inline is never cut short: commands and completions wait for it", () => {
    expect(inlineAction(facts({ busy: true, running: "reviewer" }), HELPERS)).toBe("wait");
    expect(inlineAction(facts({ completion: true, busy: true, running: "scout" }), HELPERS)).toBe("wait");
  });

  test("leaves other agents' messages, and anything when the session's state cannot be read", () => {
    expect(inlineAction(facts({ agent: "lead", busy: true, running: "reviewer" }), HELPERS)).toBe("leave");
    expect(inlineAction(facts({ agent: undefined }), HELPERS)).toBe("leave");
    expect(inlineAction(facts({ busy: undefined }), HELPERS)).toBe("leave");
    expect(inlineAction(facts({ completion: true, busy: undefined }), HELPERS)).toBe("leave");
  });
});

describe("toSubtask", () => {
  const commandParts = () => [
    { id: "prt_1", sessionID: "ses_root", messageID: "msg_1", type: "text", text: "Review the uncommitted changes." },
    { id: "prt_2", sessionID: "ses_root", messageID: "msg_1", type: "file", url: "file:///x", mime: "text/plain", filename: "x" },
  ];

  test("becomes one subtask part, in place, with the ids of the first text part", () => {
    const parts: unknown[] = commandParts();
    const same = parts;
    expect(toSubtask(parts, { agent: "reviewer", description: "Independent review", command: "review", model: { providerID: "github-copilot", modelID: "gpt-6.1-sol" } })).toBe(true);
    expect(parts).toBe(same);
    expect(parts).toEqual([
      {
        id: "prt_1",
        sessionID: "ses_root",
        messageID: "msg_1",
        type: "subtask",
        prompt: "Review the uncommitted changes.",
        description: "Independent review",
        agent: "reviewer",
        model: { providerID: "github-copilot", modelID: "gpt-6.1-sol" },
        command: "review",
      },
    ]);
  });

  test("without a command or a model, those fields are left out", () => {
    const parts: unknown[] = commandParts();
    toSubtask(parts, { agent: "scout", description: "" });
    expect(Object.keys(parts[0] as object)).toEqual(["id", "sessionID", "messageID", "type", "prompt", "description", "agent"]);
  });

  test("changes nothing when there is no text to run", () => {
    const parts: unknown[] = [{ type: "file", url: "file:///x" }];
    expect(toSubtask(parts, { agent: "reviewer", description: "" })).toBe(false);
    expect(parts).toEqual([{ type: "file", url: "file:///x" }]);
    const blank: unknown[] = [{ type: "text", text: "   " }];
    expect(toSubtask(blank, { agent: "reviewer", description: "" })).toBe(false);
  });
});

describe("giveTo", () => {
  const reviewerMessage = (): V1UserMessage => ({ agent: "reviewer", model: { providerID: "github-copilot", modelID: "gpt-6.1-sol", variant: "medium" } });

  test("with the owner's model from its latest request", () => {
    const message = reviewerMessage();
    giveTo(message, { agent: "lead", model: { providerID: "anthropic", modelID: "claude-opus-5-5", variant: "xhigh" } }, undefined);
    expect(message).toEqual({ agent: "lead", model: { providerID: "anthropic", modelID: "claude-opus-5-5", variant: "xhigh" } });
  });

  test("without one, with the owner's configured model and effort, or else the model opencode gave", () => {
    const configured = reviewerMessage();
    giveTo(configured, { agent: "lead" }, { model: "anthropic/claude-opus-5-5", effort: "xhigh" });
    expect(configured).toEqual({ agent: "lead", model: { providerID: "anthropic", modelID: "claude-opus-5-5", variant: "xhigh" } });
    const inherited = reviewerMessage();
    giveTo(inherited, { agent: "lead" }, {});
    expect(inherited).toEqual({ agent: "lead", model: { providerID: "github-copilot", modelID: "gpt-6.1-sol", variant: "medium" } });
  });
});

test("Owners keeps each session's latest owner and copies the model", () => {
  const owners = new Owners();
  const model = { providerID: "anthropic", modelID: "claude-opus-5-5" };
  owners.note("ses_1", "lead", model);
  model.modelID = "changed";
  expect(owners.get("ses_1")).toEqual({ agent: "lead", model: { providerID: "anthropic", modelID: "claude-opus-5-5" } });
  owners.note("ses_1", "build", undefined);
  expect(owners.get("ses_1")).toEqual({ agent: "build" });
  owners.note(undefined, "lead", model);
  owners.note("ses_2", "", model);
  expect(owners.get("ses_2")).toBeUndefined();
});

test("PendingCommands gives a command once, and only within a minute", () => {
  let clock = 0;
  const pending = new PendingCommands(() => clock);
  pending.note("ses_1", "review");
  expect(pending.take("ses_1")).toBe("review");
  expect(pending.take("ses_1")).toBeUndefined();
  pending.note("ses_1", "progress");
  clock = 61_000;
  expect(pending.take("ses_1")).toBeUndefined();
  pending.note(42, "review");
  expect(pending.take("42")).toBeUndefined();
});

describe("waitForIdle", () => {
  function clockAndSleep() {
    const state = { now: 0, pauses: [] as number[] };
    const sleep = async (ms: number) => {
      state.pauses.push(ms);
      state.now += ms;
    };
    return { state, options: { limitMs: 10_000, now: () => state.now, sleep } };
  }

  test("returns at once when idle, and after the pauses it took otherwise, backing off to a second", async () => {
    const idle = clockAndSleep();
    expect(await waitForIdle(async () => false, idle.options)).toBe(false);
    expect(idle.state.pauses).toEqual([]);
    const later = clockAndSleep();
    const answers = [true, true, true, true, true, false];
    expect(await waitForIdle(async () => answers.shift(), later.options)).toBe(false);
    expect(later.state.pauses).toEqual([200, 400, 800, 1000, 1000]);
  });

  test("gives up busy at the limit, and unknown after three unreadable states in a row", async () => {
    const busy = clockAndSleep();
    expect(await waitForIdle(async () => true, busy.options)).toBe(true);
    expect(busy.state.now).toBeGreaterThanOrEqual(10_000);
    const unreadable = clockAndSleep();
    const answers = [undefined, true, undefined, undefined, undefined, false];
    expect(await waitForIdle(async () => answers.shift(), unreadable.options)).toBeUndefined();
    expect(unreadable.state.pauses).toHaveLength(4);
  });
});
