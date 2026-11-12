// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { ADMITTED_MS, DELEGATION_TOOL, HelperSlots } from "./slots.ts";
import { embeddedFixture } from "./testing.ts";
import type { TrackedSession } from "./tools-v2.ts";
import type { V2ToolCall } from "./types.ts";

const harness = embeddedFixture();
const PARENT = "root";

/** A stand-in for the children snapshot: a list to answer from, and a gate that holds one answer back. */
class Children {
  sessions: TrackedSession[] = [];
  private gate: Promise<void> | undefined;
  private open: (() => void) | undefined;
  /** Resolves once a snapshot has been taken and is held at the gate. */
  taken: Promise<void> = Promise.resolve();
  private took: (() => void) | undefined;

  /** The next snapshot is taken now and answered only when `release` is called. */
  hold(): void {
    this.gate = new Promise((resolve) => (this.open = resolve));
    this.taken = new Promise((resolve) => (this.took = resolve));
  }

  release(): void {
    this.open?.();
  }

  readonly read = async (parent: string): Promise<TrackedSession[]> => {
    const snapshot = this.sessions.filter((session) => session.parentID === parent).map((session) => ({ ...session }));
    const gate = this.gate;
    this.gate = undefined;
    if (gate !== undefined) {
      this.took?.();
      await gate;
    }
    return snapshot;
  };

  set(id: string, state: TrackedSession["state"], at = 0): void {
    const session = this.sessions.find((item) => item.id === id);
    if (session !== undefined) session.state = state;
    else this.sessions.push({ id, parentID: PARENT, agent: "builder", state, startedAt: at, updatedAt: at });
  }
}

function setup(limit: number) {
  const children = new Children();
  let clock = 1_000;
  const slots = new HelperSlots({ harness, limit, helpers: new Set(["builder", "scout"]), children: children.read, now: () => clock });
  let calls = 0;
  const handOff = (id = `call${++calls}`, input: Record<string, unknown> = { agent: "builder", prompt: "do it" }) =>
    slots.admit({ tool: DELEGATION_TOOL, agent: "lead", sessionID: PARENT, id, input } as V2ToolCall);
  const emit = (type: string, sessionID: string, more: Record<string, unknown> = {}) => slots.observe({ type, data: { sessionID, ...more } });
  /** opencode's progress update for a hand-off: the call's id, and the child in its metadata. */
  const progress = (call: string, child: string) =>
    slots.observe({ type: "session.tool.progress", data: { sessionID: PARENT, assistantMessageID: "m1", id: call, metadata: { sessionID: child, status: "running" } } });
  const ended = (call: string, status: "completed" | "error", result?: unknown) =>
    slots.ended({ tool: DELEGATION_TOOL, agent: "lead", sessionID: PARENT, id: call, status, ...(result === undefined ? {} : { result }) } as V2ToolCall);
  const tick = (ms: number) => {
    clock += ms;
  };
  return { slots, children, handOff, emit, progress, ended, tick };
}

describe("helper slots", () => {
  test("a hand-off's slot is held while a check's snapshot predates its helper's run", async () => {
    const { children, handOff, emit } = setup(1);
    expect(await handOff("a")).toBeUndefined();
    emit("session.created", "x", { parentID: PARENT, agent: "builder" });
    children.set("x", "idle");
    // The next check's snapshot shows x before its run, and the run starts while the check waits.
    children.hold();
    const check = handOff("b");
    await children.taken;
    emit("session.execution.started", "x");
    children.set("x", "running");
    children.release();
    expect(await check).toContain("1 is running: builder x.");
  });

  test("a helper whose run started keeps its owner: it never satisfies another pending hand-off", async () => {
    const { children, handOff, emit } = setup(2);
    expect(await handOff("a")).toBeUndefined();
    expect(await handOff("b")).toBeUndefined();
    emit("session.created", "x", { parentID: PARENT, agent: "builder" });
    emit("session.execution.started", "x");
    children.set("x", "running");
    expect(await handOff("c")).toContain("2 are running: builder x, a helper that is starting.");
  });

  test("a helper's slot is freed by the end of its run, by each kind of end", async () => {
    for (const end of ["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"]) {
      const { children, handOff, emit, progress } = setup(1);
      expect(await handOff("a")).toBeUndefined();
      emit("session.created", "x", { parentID: PARENT, agent: "builder" });
      progress("a", "x");
      emit("session.execution.started", "x");
      expect(await handOff()).toContain("1 is running: builder x.");
      emit(end, "x");
      children.set("x", end.endsWith("succeeded") ? "done" : end.endsWith("failed") ? "failed" : "stopped");
      expect(await handOff()).toBeUndefined();
    }
  });

  test("a snapshot that shows the helper ended frees its slot only once its run was seen to start", async () => {
    const { children, handOff, emit } = setup(1);
    children.set("c2", "done");
    // A continued idle helper: its last run ended before this one starts.
    expect(await handOff("k", { agent: "builder", prompt: "more", sessionID: "c2" })).toBeUndefined();
    expect(await handOff()).toContain("1 is running: builder c2.");
    // A late end event of its last run does not free it.
    emit("session.execution.succeeded", "c2");
    expect(await handOff()).toContain("1 is running: builder c2.");
    // The run starts while a check's snapshot still shows the last one ended.
    children.hold();
    const check = handOff();
    await children.taken;
    emit("session.execution.started", "c2");
    children.set("c2", "running");
    children.release();
    expect(await check).toContain("1 is running: builder c2.");
    // Its end event is lost; a later snapshot shows the run ended.
    expect(await handOff()).toContain("1 is running: builder c2.");
    children.set("c2", "done");
    expect(await handOff()).toBeUndefined();
  });

  test("a reservation whose helper is never heard of again lapses after ADMITTED_MS from its last event", async () => {
    const { handOff, emit, tick } = setup(1);
    expect(await handOff("a")).toBeUndefined();
    tick(ADMITTED_MS - 10);
    emit("session.created", "x", { parentID: PARENT, agent: "builder" });
    emit("session.execution.started", "x");
    tick(ADMITTED_MS - 10);
    expect(await handOff()).toContain("1 is running: builder x.");
    tick(20);
    expect(await handOff()).toBeUndefined();
  });

  test("a hand-off nobody hears of lapses after ADMITTED_MS; one that fails frees its slot at once", async () => {
    const { slots, handOff, tick } = setup(1);
    expect(await handOff("a")).toBeUndefined();
    expect(await handOff()).toContain("a helper that is starting");
    tick(ADMITTED_MS);
    expect(await handOff("b")).toBeUndefined();
    slots.ended({ tool: DELEGATION_TOOL, id: "b", status: "error" } as V2ToolCall);
    expect(await handOff()).toBeUndefined();
  });

  test("a hand-off that fails gives the helper it was guessed to own back to the hand-off still waiting for one", async () => {
    const { children, handOff, emit, ended } = setup(2);
    expect(await handOff("a")).toBeUndefined();
    expect(await handOff("b")).toBeUndefined();
    // b's helper appears first and is guessed to be a's; then a fails before it creates one.
    emit("session.created", "y", { parentID: PARENT, agent: "builder" });
    emit("session.execution.started", "y");
    children.set("y", "running");
    ended("a", "error");
    expect(await handOff("c")).toBeUndefined();
    expect(await handOff("d")).toContain("2 are running: builder y, a helper that is starting.");
  });

  for (const source of ["progress", "result"] as const) {
    test(`the hand-off that created a helper owns it, as opencode's ${source === "progress" ? "progress update" : "call result"} says, over a wrong guess`, async () => {
      const { handOff, emit, progress, ended } = setup(2);
      expect(await handOff("a")).toBeUndefined();
      expect(await handOff("b")).toBeUndefined();
      // y is b's: the guess gives it to a, the call's own update corrects that.
      emit("session.created", "y", { parentID: PARENT, agent: "builder" });
      if (source === "progress") progress("b", "y");
      else ended("b", "completed", { output: { sessionID: "y", status: "running" }, metadata: { sessionID: "y", status: "running" } });
      emit("session.execution.started", "y");
      emit("session.execution.succeeded", "y");
      // y has ended, so b's slot is free; a fails before creating a helper, so its slot is free too.
      ended("a", "error");
      expect(await handOff("c")).toBeUndefined();
      expect(await handOff("d")).toBeUndefined();
    });
  }

  test("a helper's own update moves it to its hand-off, and the guessed hand-off takes the helper its call left", async () => {
    const { handOff, emit, progress, ended } = setup(2);
    expect(await handOff("a")).toBeUndefined();
    expect(await handOff("b")).toBeUndefined();
    emit("session.created", "y", { parentID: PARENT, agent: "builder" });
    emit("session.created", "x", { parentID: PARENT, agent: "scout" });
    // The guesses were a: y and b: x; the updates say the opposite.
    progress("b", "y");
    progress("a", "x");
    emit("session.execution.started", "x");
    emit("session.execution.started", "y");
    // b's foreground helper fails, and so does b; a's helper x still runs.
    emit("session.execution.failed", "y");
    ended("b", "error");
    expect(await handOff("c")).toBeUndefined();
    expect(await handOff("d")).toContain("2 are running: scout x, a helper that is starting.");
  });

  test("two calls continuing the same idle helper each hold its slot: one failing leaves the other's", async () => {
    const { children, handOff, ended } = setup(1);
    children.set("c2", "done");
    const resume = { agent: "builder", prompt: "more", sessionID: "c2" };
    expect(await handOff("k1", resume)).toBeUndefined();
    // The second continuation is admitted, since c2 already holds the slot, and tracked.
    expect(await handOff("k2", resume)).toBeUndefined();
    ended("k1", "error");
    expect(await handOff("n")).toContain("1 is running: builder c2.");
    ended("k2", "error");
    expect(await handOff("n2")).toBeUndefined();
  });

  test("continuing a running helper is tracked until that run ends", async () => {
    const { children, handOff, emit } = setup(1);
    children.set("c1", "running");
    expect(await handOff("k", { agent: "builder", prompt: "more", sessionID: "c1" })).toBeUndefined();
    expect(await handOff()).toContain("1 is running: builder c1.");
    emit("session.execution.succeeded", "c1");
    children.set("c1", "done");
    expect(await handOff()).toBeUndefined();
  });

  test("a run end on a wrong guess keeps the slot until the call answers: the real call failing leaves the other hand-off counted", async () => {
    const { handOff, emit, ended } = setup(2);
    expect(await handOff("a")).toBeUndefined();
    expect(await handOff("b")).toBeUndefined();
    // No progress updates (Code Mode): y is b's but guessed to be a's, and it runs and fails.
    emit("session.created", "y", { parentID: PARENT, agent: "builder" });
    emit("session.execution.started", "y");
    emit("session.execution.failed", "y");
    // b's foreground call fails with its helper; a has not created its helper yet.
    ended("b", "error");
    expect(await handOff("c")).toBeUndefined();
    expect(await handOff("d")).toContain("2 are running: a helper that is starting, a helper that is starting.");
  });

  test("a run end on a wrong guess leaves no phantom slot once the calls name their helpers", async () => {
    const { children, handOff, emit, ended } = setup(2);
    expect(await handOff("a")).toBeUndefined();
    expect(await handOff("b")).toBeUndefined();
    // Guessed a: y and b: x; really a: x and b: y.
    emit("session.created", "y", { parentID: PARENT, agent: "builder" });
    emit("session.created", "x", { parentID: PARENT, agent: "scout" });
    emit("session.execution.started", "y");
    emit("session.execution.started", "x");
    children.set("x", "running");
    emit("session.execution.succeeded", "y");
    children.set("y", "done");
    ended("b", "completed", { output: { sessionID: "y", status: "completed" }, metadata: { sessionID: "y", status: "completed" } });
    ended("a", "completed", { output: { sessionID: "x", status: "running" }, metadata: { sessionID: "x", status: "running" } });
    expect(await handOff("c")).toBeUndefined();
    expect(await handOff("d")).toContain("2 are running: ");
    ended("c", "error");
    emit("session.execution.succeeded", "x");
    children.set("x", "done");
    expect(await handOff("e")).toBeUndefined();
    expect(await handOff("f")).toBeUndefined();
  });
});
