// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { INLINE_USER_AND_REPORTS_WAKE_TEXT, INLINE_USER_WAKE_TEXT, INLINE_WAKE_TEXT, V2_CONTINUE_NOTES, WAKE_TEXT, heldReportsV2, stepsV2 } from "./answer-first.ts";
import { helperIds } from "./helpers.ts";
import { HELD_NOTE, INLINE_MARK, Inline, InlineRuns, briefIndex, classifyHelperRequest, inlineCommands, isUserMessage, isolateHelperRequest, type InlineRun } from "./inline.ts";
import type { Reporter } from "./report.ts";
import { embeddedFixture } from "./testing.ts";
import { SessionTracker } from "./tools-v2.ts";
import type { V2Context, V2ModelMessage, V2ModelRef } from "./types.ts";

const harness = embeddedFixture();
const helpers = helperIds(harness);
const text = (message: V2ModelMessage | undefined) => message?.content?.[0]?.text;
const user = (body: string, id?: string, metadata?: Record<string, unknown>): V2ModelMessage => ({
  ...(id !== undefined ? { id } : {}),
  role: "user",
  content: [{ type: "text", text: body }],
  ...(metadata !== undefined ? { metadata } : {}),
});
const said = (body: string): V2ModelMessage => ({ role: "assistant", content: [{ type: "text", text: body }] });
const step = (id: string): V2ModelMessage[] => [
  { role: "assistant", content: [{ type: "tool-call", id, name: "shell", input: {} }] },
  { role: "tool", content: [{ type: "tool-result", id, name: "shell", result: { type: "text", value: "ok" } }] },
];
const report = (id: string) => user(`<subagent sessionID="ses_${id}" state="completed">\nbuilder finished\n</subagent>`, id);
const brief = (body = "Review the target below.\n\nTarget: main") => user(body, "msg_brief", { [INLINE_MARK]: "review" });
/** A message the user typed: opencode gives every user message metadata, synthetic notes none. */
const typed = (body: string, id: string) => user(body, id, {});
const none = { reports: [], user: [] };

test("the commands a helper answers are the harness's commands whose agent is a helper", () => {
  expect(inlineCommands(harness, helpers).map((command) => [command.name, command.agent])).toEqual([
    ["review", "reviewer"],
    ["progress", "scout"],
  ]);
});

describe("isolateHelperRequest", () => {
  test("drops everything before the brief, found by its mark", () => {
    const messages = [user("hello"), said("hi"), brief(), ...step("c1")];
    expect(isolateHelperRequest(messages, undefined)).toEqual(none);
    expect(messages.map(text)[0]).toStartWith("Review the target");
    expect(messages).toHaveLength(3);
  });

  test("finds the brief by its exact text when the mark did not come through", () => {
    const messages = [user("hello"), said("hi"), user("Review X"), said("VERDICT")];
    expect(briefIndex(messages, "Review X")).toBe(2);
    expect(briefIndex(messages, "Review Y")).toBe(-1);
  });

  test("leaves out reports, by message id, and keeps the helper's steps", () => {
    const messages = [user("hello"), brief(), ...step("c1"), report("r1"), ...step("c2")];
    expect(isolateHelperRequest(messages, undefined)).toEqual({ reports: ["r1"], user: [] });
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "tool", "assistant", "tool"]);
  });

  test("a report after the helper's answer is replaced by a note, so the request ends with a user message", () => {
    const messages = [brief(), said("VERDICT: APPROVE"), report("r1"), report("r2")];
    expect(isolateHelperRequest(messages, undefined)).toEqual({ reports: ["r1", "r2"], user: [] });
    expect(messages.map(text)).toEqual([text(brief()), "VERDICT: APPROVE", HELD_NOTE]);
  });

  test("leaves out the user's messages after the brief, by message id, and keeps the helper's steps", () => {
    const messages = [typed("hello", "u0"), said("hi"), brief(), ...step("c1"), typed("Is main safe to merge?", "u1"), ...step("c2")];
    expect(isolateHelperRequest(messages, undefined)).toEqual({ reports: [], user: ["u1"] });
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "tool", "assistant", "tool"]);
    expect(messages.map(text)).not.toContain("Is main safe to merge?");
  });

  test("a user's message and reports after the helper's answer are replaced by one note", () => {
    const messages = [brief(), said("VERDICT: APPROVE"), typed("And the tests?", "u1"), report("r1")];
    expect(isolateHelperRequest(messages, undefined)).toEqual({ reports: ["r1"], user: ["u1"] });
    expect(messages.map(text)).toEqual([text(brief()), "VERDICT: APPROVE", HELD_NOTE]);
  });

  test("notes opencode adds stay with the helper: synthetic notes, continue notes, checkpoints", () => {
    const background = "User requested that active blocking work be moved to the background.";
    const checkpoint = "<conversation-checkpoint>\nsummary\n</conversation-checkpoint>";
    const messages = [brief(), said("partial"), user(V2_CONTINUE_NOTES[0]!, "n1", {}), ...step("c1"), user(background, "s1"), user(checkpoint, "k1", {})];
    expect(isolateHelperRequest(messages, undefined)).toEqual(none);
    expect(messages).toHaveLength(7);
  });

  test("without a brief the user's messages stay, since nothing tells which came after it", () => {
    const messages = [typed("hello", "u0"), said("VERDICT"), typed("more", "u1")];
    expect(isolateHelperRequest(messages, "Review X")).toEqual(none);
    expect(messages).toHaveLength(3);
  });

  test("no note when nothing was left out, or when a tool result comes last", () => {
    const answered = [brief(), said("VERDICT: APPROVE")];
    isolateHelperRequest(answered, undefined);
    expect(answered).toHaveLength(2);
    const working = [brief(), ...step("c1"), report("r1")];
    isolateHelperRequest(working, undefined);
    expect(working.map((message) => message.role)).toEqual(["user", "assistant", "tool"]);
  });

  test("without a brief nothing is dropped, and reports are still left out", () => {
    const messages = [user("hello"), said("VERDICT"), report("r1")];
    expect(isolateHelperRequest(messages, undefined)).toEqual({ reports: ["r1"], user: [] });
    expect(messages.map(text)).toEqual(["hello", "VERDICT", HELD_NOTE]);
  });
});

test("a user's message is a request with metadata; reports, notes and the plugin's wakes are not", () => {
  expect(isUserMessage(typed("Is it safe?", "u1"))).toBe(true);
  expect(isUserMessage(user("Is it safe?", "s1"))).toBe(false);
  expect(isUserMessage(user(report("r1").content![0]!.text!, "r1", {}))).toBe(false);
  expect(isUserMessage(user(V2_CONTINUE_NOTES[1]!, "n1", {}))).toBe(false);
  for (const wake of [WAKE_TEXT, INLINE_WAKE_TEXT, INLINE_USER_WAKE_TEXT, INLINE_USER_AND_REPORTS_WAKE_TEXT]) expect(isUserMessage(user(wake, "w", {}))).toBe(false);
  expect(isUserMessage(said("hi"))).toBe(false);
  expect(isUserMessage(undefined)).toBe(false);
});

describe("classifyHelperRequest", () => {
  const run: InlineRun = { command: "review", helper: "reviewer", owner: "lead", switchedModel: false, brief: "b", held: new Set(), heldUser: new Set() };
  test("inline for the running command's helper in the user's session; stray after a run; leave otherwise", () => {
    expect(classifyHelperRequest("reviewer", run, false, true, helpers)).toBe("inline");
    expect(classifyHelperRequest("scout", run, false, true, helpers)).toBe("leave");
    expect(classifyHelperRequest("reviewer", undefined, true, true, helpers)).toBe("stray");
    expect(classifyHelperRequest("reviewer", undefined, false, true, helpers)).toBe("leave");
    expect(classifyHelperRequest("reviewer", run, true, false, helpers)).toBe("leave");
    expect(classifyHelperRequest("lead", run, true, true, helpers)).toBe("leave");
    expect(classifyHelperRequest(undefined, run, true, true, helpers)).toBe("leave");
  });
});

describe("InlineRuns", () => {
  test("a finished run stays known for stray requests; each report is claimed for a wake once", () => {
    const runs = new InlineRuns();
    runs.start("s", { command: "review", helper: "reviewer", owner: "lead", switchedModel: false, brief: "b", held: new Set(["r1"]), heldUser: new Set() });
    expect(runs.get("s")?.helper).toBe("reviewer");
    expect(runs.last("s")).toBeUndefined();
    runs.finish("s");
    expect(runs.get("s")).toBeUndefined();
    expect(runs.last("s")?.owner).toBe("lead");
    expect(runs.claim("s", ["r1", "r1"])).toEqual(["r1"]);
    expect(runs.claim("s", ["r1", "r2"])).toEqual(["r2"]);
    expect(runs.claim("other", ["r1"])).toEqual(["r1"]);
  });
});

test("answer-first reads the inline wake as the end of a reply, like its own wake", () => {
  expect(stepsV2([user(WAKE_TEXT), user(INLINE_WAKE_TEXT), user("question")])).toEqual(["boundary", "boundary", "request"]);
});

test("answer-first reads a wake for the user's message as a request: a report that arrives while lead answers it is held", () => {
  for (const wake of [INLINE_USER_WAKE_TEXT, INLINE_USER_AND_REPORTS_WAKE_TEXT]) {
    const messages = [brief(), ...step("c1"), typed("Is main safe to merge?", "u1"), said("VERDICT: APPROVE"), report("r1"), user(wake, "w1"), ...step("c2"), report("r2")];
    expect(stepsV2(messages).slice(5, 7)).toEqual(["report", "request"]);
    // The report held with the user's message is in view; the one that arrives as lead answers waits.
    expect(heldReportsV2(messages)).toEqual({ held: [9], reply: `6\n${wake}` });
  }
});

// ---------------------------------------------------------------------------------------------
// A run against a scripted session API

class FakeSessions {
  calls: string[] = [];
  agent = "lead";
  model: V2ModelRef | undefined = { id: "m1", providerID: "mock" };
  parents: Record<string, string | undefined> = {};
  prompts: Array<Record<string, unknown>> = [];
  synthetics: Array<{ sessionID: string; text: string; description?: string; delivery?: string }> = [];
  /** Each `wait` call waits for the next `release()`. */
  private waiting: Array<() => void> = [];
  autoRelease = true;
  agentModels: Record<string, V2ModelRef | undefined> = {};

  release(): void {
    this.waiting.shift()?.();
  }

  get pendingWaits(): number {
    return this.waiting.length;
  }

  readonly ctx: V2Context = {
    agent: {
      transform: async () => ({ dispose: async () => {} }),
      get: async ({ agentID }) => ({ data: { id: agentID, ...(this.agentModels[agentID] ? { model: this.agentModels[agentID] } : {}) } }),
    },
    session: {
      get: async ({ sessionID }) => ({ id: sessionID, agent: this.agent, ...(this.model ? { model: this.model } : {}), ...(this.parents[sessionID] ? { parentID: this.parents[sessionID] } : {}) }),
      wait: async () => {
        this.calls.push("wait");
        if (this.autoRelease) return;
        await new Promise<void>((resolve) => this.waiting.push(resolve));
      },
      switchAgent: async ({ agent }) => {
        this.calls.push(`agent:${agent}`);
        this.agent = agent;
      },
      switchModel: async ({ model }) => {
        this.calls.push(`model:${model.providerID}/${model.id}`);
        this.model = model;
      },
      prompt: async (input) => {
        this.calls.push("prompt");
        this.prompts.push(input);
        return {};
      },
      synthetic: async (input) => {
        this.calls.push("wake");
        this.synthetics.push(input);
        return {};
      },
    },
  };
}

const quiet: Reporter = { report: () => {}, internal: (where, error) => console.error(where, error) };
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

function makeInline(sessions = new FakeSessions(), planned: Record<string, V2ModelRef> = {}) {
  const tracker = new SessionTracker();
  const inline = new Inline({ harness, ctx: sessions.ctx, tracker, helpers, reporter: quiet, plannedModel: (agent) => planned[agent] });
  const review = inline.commands().find((command) => command.name === "review")!;
  return { sessions, tracker, inline, review };
}

describe("Inline", () => {
  test("registers the embedded helpers' commands", () => {
    const { inline } = makeInline();
    expect(inline.commands().map((command) => command.name)).toEqual(["review", "progress"]);
    expect(inline.available()).toBe(true);
  });

  test("an idle session: execute returns at once; the helper answers its brief; the owner is back after", async () => {
    const sessions = new FakeSessions();
    sessions.autoRelease = false;
    const { inline, review } = makeInline(sessions);
    await review.execute({ sessionID: "s", prompt: { text: "main" }, delivery: "steer" });
    expect(sessions.calls).toEqual(["wait"]);
    sessions.release();
    await settle();
    expect(sessions.calls).toEqual(["wait", "agent:reviewer", "prompt", "wait"]);
    expect(sessions.prompts[0]).toEqual({ text: "Review main", sessionID: "s", metadata: { [INLINE_MARK]: "review" }, delivery: "steer" });
    expect(inline.runs.get("s")?.owner).toBe("lead");

    // The reviewer's request sees only its brief; lead's request is not this module's.
    const event = { sessionID: "s", agent: "reviewer", messages: [user("hello"), said("hi"), user("Review main", "msg_b"), ...step("c1"), report("r1")] };
    expect(await inline.context(event)).toBe(true);
    expect(event.messages.map(text)[0]).toBe("Review main");
    expect(event.messages).toHaveLength(3);
    expect(await inline.context({ sessionID: "s", agent: "lead", messages: [user("x")] })).toBe(false);

    sessions.release();
    await settle();
    expect(sessions.calls).toEqual(["wait", "agent:reviewer", "prompt", "wait", "agent:lead", "wake"]);
    expect(sessions.synthetics).toEqual([{ sessionID: "s", text: INLINE_WAKE_TEXT, description: "Reports held while a helper answered", delivery: "queue" }]);
    expect(inline.runs.get("s")).toBeUndefined();
  });

  test("no wake when no report was held; the helper's own model is used and the owner's comes back", async () => {
    const sessions = new FakeSessions();
    sessions.agentModels.reviewer = { id: "m2", providerID: "mock" };
    const { review } = makeInline(sessions);
    await review.execute({ sessionID: "s", prompt: { text: "" } });
    await settle();
    expect(sessions.calls).toEqual(["wait", "agent:reviewer", "model:mock/m2", "prompt", "wait", "agent:lead", "model:mock/m1"]);
    expect(sessions.prompts[0]!.text).toBe("Review");
  });

  test("a session without a model of its own goes back to the default model after the helper's", async () => {
    const sessions = new FakeSessions();
    sessions.model = undefined;
    sessions.agentModels.reviewer = { id: "m2", providerID: "mock" };
    sessions.ctx.model = { default: async () => ({ data: { id: "m0", providerID: "mock", name: "Default" } }) };
    const { review } = makeInline(sessions);
    await review.execute({ sessionID: "s", prompt: { text: "x" } });
    await settle();
    expect(sessions.calls.slice(-2)).toEqual(["agent:lead", "model:mock/m0"]);
  });

  test("the settings' model applies when opencode does not name one; no switch when it is the owner's", async () => {
    const sessions = new FakeSessions();
    const { review } = makeInline(sessions, { reviewer: { id: "m1", providerID: "mock" } });
    await review.execute({ sessionID: "s", prompt: { text: "x" } });
    await settle();
    expect(sessions.calls).toEqual(["wait", "agent:reviewer", "prompt", "wait", "agent:lead"]);
    const planned = makeInline(new FakeSessions(), { reviewer: { id: "m3", providerID: "mock" } });
    await planned.review.execute({ sessionID: "s", prompt: { text: "x" } });
    await settle();
    expect(planned.sessions.calls).toContain("model:mock/m3");
    expect(planned.sessions.calls.at(-1)).toBe("model:mock/m1");
  });

  test("a busy session: the run waits until the session is idle, also for a run the tracker saw start after", async () => {
    const sessions = new FakeSessions();
    sessions.autoRelease = false;
    const { review, tracker } = makeInline(sessions);
    tracker.observe({ type: "session.execution.started", data: { sessionID: "s" } });
    await review.execute({ sessionID: "s", prompt: { text: "x" } });
    sessions.release();
    await settle();
    expect(sessions.calls).toEqual(["wait", "wait"]);
    tracker.observe({ type: "session.execution.succeeded", data: { sessionID: "s" } });
    sessions.release();
    await settle();
    expect(sessions.calls).toEqual(["wait", "wait", "agent:reviewer", "prompt", "wait"]);
  });

  test("two commands in one session run one after the other", async () => {
    const sessions = new FakeSessions();
    sessions.autoRelease = false;
    const { inline, review } = makeInline(sessions);
    const progress = inline.commands().find((command) => command.name === "progress")!;
    await review.execute({ sessionID: "s", prompt: { text: "a" } });
    await progress.execute({ sessionID: "s", prompt: { text: "b" } });
    for (let index = 0; index < 4; index++) {
      sessions.release();
      await settle();
    }
    expect(sessions.calls).toEqual(["wait", "agent:reviewer", "prompt", "wait", "agent:lead", "wait", "agent:scout", "prompt", "wait", "agent:lead"]);
  });

  test("a stray request after a run: reports left out, the owner restored, lead woken once per report", async () => {
    const sessions = new FakeSessions();
    const { inline, review } = makeInline(sessions);
    await review.execute({ sessionID: "s", prompt: { text: "x" } });
    await settle();
    sessions.calls = [];
    sessions.agent = "reviewer";
    const event = { sessionID: "s", agent: "reviewer", messages: [user("hello"), user("Review x", "msg_b"), said("VERDICT"), report("r9")] };
    expect(await inline.context(event)).toBe(true);
    expect(event.messages.map(text)).toEqual(["Review x", "VERDICT", HELD_NOTE]);
    await settle();
    expect(sessions.calls).toEqual(["agent:lead", "wake"]);
    // The same report in the next request: the owner is restored again, but no second wake.
    await inline.context({ sessionID: "s", agent: "reviewer", messages: [user("Review x"), said("VERDICT"), report("r9")] });
    await settle();
    expect(sessions.calls).toEqual(["agent:lead", "wake", "agent:lead"]);
  });

  /** A run whose helper's requests are `requests`, made while the run is going on. */
  async function runWith(...requests: V2ModelMessage[][]) {
    const sessions = new FakeSessions();
    sessions.autoRelease = false;
    const { inline, review } = makeInline(sessions);
    await review.execute({ sessionID: "s", prompt: { text: "main" } });
    sessions.release();
    await settle();
    for (const messages of requests) expect(await inline.context({ sessionID: "s", agent: "reviewer", messages })).toBe(true);
    sessions.release();
    await settle();
    return { sessions, inline };
  }

  test("a message the user typed during the run is held back from the helper; after the switch back, lead is woken to answer it", async () => {
    const asked = typed("Is main safe to merge?", "u1");
    const first = [user("hello"), user("Review main", "msg_b"), ...step("c1"), asked, ...step("c2")];
    const { sessions, inline } = await runWith(first, [user("Review main", "msg_b"), ...step("c1"), asked, ...step("c2"), said("VERDICT")]);
    expect(first.map(text)).not.toContain("Is main safe to merge?");
    expect(sessions.calls.slice(-2)).toEqual(["agent:lead", "wake"]);
    expect(sessions.synthetics).toEqual([{ sessionID: "s", text: INLINE_USER_WAKE_TEXT, description: "Message held while a helper answered", delivery: "queue" }]);
    expect(inline.runs.last("s")?.heldUser).toEqual(new Set(["u1"]));
  });

  test("a user's message and reports held in one run: one wake, to answer the user first", async () => {
    const { sessions } = await runWith([user("Review main", "msg_b"), ...step("c1"), report("r1"), typed("And the tests?", "u1"), ...step("c2")]);
    expect(sessions.synthetics.map((item) => item.text)).toEqual([INLINE_USER_AND_REPORTS_WAKE_TEXT]);
  });

  test("a stray request with the user's message: held back, the owner restored, lead woken to answer it once", async () => {
    const sessions = new FakeSessions();
    const { inline, review } = makeInline(sessions);
    await review.execute({ sessionID: "s", prompt: { text: "x" } });
    await settle();
    sessions.calls = [];
    sessions.agent = "reviewer";
    const messages = [user("Review x", "msg_b"), said("VERDICT"), typed("thanks, now fix it", "u9")];
    expect(await inline.context({ sessionID: "s", agent: "reviewer", messages })).toBe(true);
    expect(messages.map(text)).toEqual(["Review x", "VERDICT", HELD_NOTE]);
    await settle();
    await inline.context({ sessionID: "s", agent: "reviewer", messages: [user("Review x"), said("VERDICT"), typed("thanks, now fix it", "u9")] });
    await settle();
    expect(sessions.calls).toEqual(["agent:lead", "wake", "agent:lead"]);
    expect(sessions.synthetics.map((item) => item.text)).toEqual([INLINE_USER_WAKE_TEXT]);
  });

  test("a helper in a child session, or in a session that never ran a command, is left alone", async () => {
    const sessions = new FakeSessions();
    sessions.parents.c = "s";
    const { inline, review } = makeInline(sessions);
    const fresh = { sessionID: "x", agent: "reviewer", messages: [user("hello"), report("r1")] };
    expect(await inline.context(fresh)).toBe(false);
    expect(fresh.messages).toHaveLength(2);
    await review.execute({ sessionID: "c", prompt: { text: "x" } });
    await settle();
    const child = { sessionID: "c", agent: "reviewer", messages: [user("hello"), report("r1")] };
    expect(await inline.context(child)).toBe(false);
  });

  test("a session left on a helper goes back to the owner noted before, not to the helper", async () => {
    const sessions = new FakeSessions();
    const { review } = makeInline(sessions);
    sessions.agent = "scout";
    await review.execute({ sessionID: "s", prompt: { text: "x" } });
    await settle();
    expect(sessions.calls.at(-1)).toBe("agent:lead");
  });

  test("a failing prompt still switches back, and the error is reported", async () => {
    const sessions = new FakeSessions();
    const errors: string[] = [];
    sessions.ctx.session!.prompt = async () => {
      throw new Error("closed");
    };
    const inline = new Inline({ harness, ctx: sessions.ctx, tracker: new SessionTracker(), helpers, reporter: { report: () => {}, internal: (where) => errors.push(where) }, plannedModel: () => undefined });
    await inline.commands()[0]!.execute({ sessionID: "s", prompt: { text: "x" } });
    await settle();
    expect(sessions.calls).toEqual(["wait", "agent:reviewer", "agent:lead"]);
    expect(errors).toEqual(["the /review command"]);
  });

  test("not available without the session calls a run needs", () => {
    const sessions = new FakeSessions();
    delete (sessions.ctx.session as { wait?: unknown }).wait;
    expect(makeInline(sessions).inline.available()).toBe(false);
  });
});
