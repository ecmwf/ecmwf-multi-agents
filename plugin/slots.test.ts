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
  const tick = (ms: number) => {
    clock += ms;
  };
  return { slots, children, handOff, emit, tick };
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
      const { children, handOff, emit } = setup(1);
      expect(await handOff("a")).toBeUndefined();
      emit("session.created", "x", { parentID: PARENT, agent: "builder" });
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
});
