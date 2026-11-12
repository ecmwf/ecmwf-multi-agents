// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

// The `max_helper_slots` limit, enforced. lead's prompt says how many helpers may run at once;
// the plugin's `execute.before` tool hook (v2.ts) also refuses lead's hand-off while that many
// of its helpers hold a slot. A helper holds one while it runs, and a hand-off admitted here
// holds one from then until its helper has started, so several hand-offs in one step count one
// by one. Continuing a running helper with its `sessionID` takes no new slot; continuing an idle
// one starts a run, so it takes one like a new hand-off. Only lead is limited.

import { slotsFullResult, type BusySlot } from "./helpers.ts";
import { eventFields, type TrackedSession } from "./tools-v2.ts";
import type { EmbeddedHarness, V2Event, V2ToolCall } from "./types.ts";

/** opencode's delegation tool (`SubagentTool` in core/src/tool/plugin/subagent.ts, opencode 2.2.5). */
export const DELEGATION_TOOL = "subagent";
/**
 * How long an admitted hand-off holds its slot after the last event of its helper (or after the
 * hand-off, before its helper is known), in case the events that end it are lost.
 */
export const ADMITTED_MS = 120_000;
/** The events that end a run (`Execution` in schema/src/session-event.ts, opencode 2.2.5). */
const RUN_ENDS: ReadonlySet<string> = new Set(["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"]);
/** How many helpers that held a slot are remembered, so none is taken for another hand-off. */
const OWNED_MAX = 1_000;

interface Admitted {
  /** The tool call's id, which `execute.after` repeats. */
  call: string;
  /** lead's session. */
  parent: string;
  /** The hand-off, then the latest event of its helper. */
  at: number;
  /** The children lead's session had when the hand-off was admitted: none of them is its helper. */
  before: ReadonlySet<string>;
  /** The helper's session, once known. */
  child?: string;
  /** The helper's agent, as its creation announced it. */
  agent?: string;
  /** A continued helper: its slot is held until its run is seen, since it is idle until then. */
  resumed?: boolean;
  /** The number of the event that started the helper's run, once seen. */
  started?: number;
}

export interface SlotDeps {
  harness: EmbeddedHarness;
  limit: number;
  helpers: ReadonlySet<string>;
  /** The children of a session with their state: opencode's list, else the event tracker. */
  children: (parent: string) => Promise<TrackedSession[]>;
  now?: () => number;
}

/** The helper a call continues, if it names one: opencode drops an empty `sessionID`. */
function continued(input: unknown): string | undefined {
  const sessionID = input !== null && typeof input === "object" ? (input as { sessionID?: unknown }).sessionID : undefined;
  return typeof sessionID === "string" && sessionID !== "" ? sessionID : undefined;
}

const ENDED: ReadonlySet<TrackedSession["state"]> = new Set(["done", "failed", "stopped"]);

export class HelperSlots {
  private admitted: Admitted[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private unnamed = 0;
  /** Events seen so far: a snapshot read after the event numbered `n` reflects it. */
  private events = 0;
  /** Helpers that hold or held a hand-off's slot, oldest first. */
  private owned = new Set<string>();

  constructor(private readonly deps: SlotDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /**
   * The refusal for a tool call, or undefined when it may run. Checks run one after the other,
   * so a hand-off admitted in the same step is counted by the next check.
   */
  admit(call: V2ToolCall | undefined): Promise<string | undefined> {
    if (call?.tool !== DELEGATION_TOOL || call.agent !== this.deps.harness.defaultAgent) return Promise.resolve(undefined);
    if (typeof call.sessionID !== "string" || call.sessionID === "") return Promise.resolve(undefined);
    const target = continued(call.input);
    const check = this.queue.then(() => this.check(call.sessionID, call.id, target));
    this.queue = check.catch(() => undefined);
    return check;
  }

  private own(entry: Admitted, child: string): void {
    entry.child = child;
    this.owned.delete(child);
    this.owned.add(child);
    if (this.owned.size > OWNED_MAX) this.owned.delete(this.owned.values().next().value!);
  }

  private async check(parent: string, call: string | undefined, target?: string): Promise<string | undefined> {
    const now = this.now();
    this.admitted = this.admitted.filter((entry) => now - entry.at < ADMITTED_MS);
    const seen = this.events;
    const children = await this.deps.children(parent);
    const byId = new Map(children.map((child) => [child.id, child]));
    const busy: BusySlot[] = [];
    const counted = new Set<string>();
    for (const child of children) {
      if (child.state !== "running" || (child.agent !== undefined && !this.deps.helpers.has(child.agent))) continue;
      busy.push({ id: child.id, ...(child.agent === undefined ? {} : { agent: child.agent }) });
      counted.add(child.id);
    }
    // An admitted hand-off whose helper the plugin has not seen yet takes the earliest new child
    // that no hand-off owns or owned, so a helper opencode lists before its events arrive is not
    // counted twice and never stands for two hand-offs.
    const earliest = [...children].sort((a, b) => a.startedAt - b.startedAt);
    for (const entry of this.admitted) {
      if (entry.parent !== parent || entry.child !== undefined) continue;
      const match = earliest.find((child) => !this.owned.has(child.id) && !entry.before.has(child.id) && !ENDED.has(child.state));
      if (match !== undefined) this.own(entry, match.id);
    }
    // A snapshot shows a helper's run ended only if it was read after that run was seen to start.
    this.admitted = this.admitted.filter((entry) => {
      const child = entry.child === undefined ? undefined : byId.get(entry.child);
      return entry.parent !== parent || child === undefined || entry.started === undefined || entry.started > seen || !ENDED.has(child.state);
    });
    for (const entry of this.admitted) {
      if (entry.parent !== parent) continue;
      if (entry.child === undefined) {
        busy.push({});
        continue;
      }
      if (counted.has(entry.child)) continue;
      const agent = byId.get(entry.child)?.agent ?? entry.agent;
      busy.push({ id: entry.child, ...(agent === undefined ? {} : { agent }) });
      counted.add(entry.child);
    }
    // Continuing a helper that already holds a slot adds nothing.
    if (target !== undefined && counted.has(target)) return undefined;
    if (busy.length >= this.deps.limit) return slotsFullResult(this.deps.harness.name, this.deps.limit, busy);
    const entry: Admitted = { call: call ?? `unnamed-${++this.unnamed}`, parent, at: now, before: new Set(byId.keys()) };
    if (target !== undefined) {
      entry.resumed = true;
      this.own(entry, target);
    }
    this.admitted.push(entry);
    return undefined;
  }

  /**
   * A hand-off has returned. One that failed frees its slot at once; a background one that
   * succeeded keeps it until its helper's run is seen, since the run starts just after.
   */
  ended(call: V2ToolCall | undefined): void {
    if (call?.tool !== DELEGATION_TOOL || typeof call.id !== "string") return;
    if (call.status === "error") this.admitted = this.admitted.filter((entry) => entry.call !== call.id);
  }

  /**
   * Feed one event: a new child takes an admitted hand-off's slot, and keeps it until its run
   * ends. Any event of the helper renews its hold.
   */
  observe(envelope: V2Event | undefined): void {
    const event = eventFields(envelope);
    const id = event?.sessionID;
    if (event === undefined || typeof id !== "string" || id === "") return;
    const number = ++this.events;
    if (event.type === "session.created") {
      if (typeof event.parentID !== "string" || this.owned.has(id)) return;
      const entry = this.admitted.find((item) => item.parent === event.parentID && item.child === undefined);
      if (entry === undefined) return;
      this.own(entry, id);
      entry.at = this.now();
      if (typeof event.agent === "string") entry.agent = event.agent;
      return;
    }
    const mine = this.admitted.filter((entry) => entry.child === id);
    if (mine.length === 0) return;
    if (event.type !== undefined && RUN_ENDS.has(event.type)) {
      // A continued helper's run ends only after it started; an earlier end is its last run's.
      this.admitted = this.admitted.filter((entry) => entry.child !== id || (entry.resumed === true && entry.started === undefined));
      return;
    }
    for (const entry of mine) {
      entry.at = this.now();
      if (event.type === "session.execution.started") entry.started = number;
    }
  }
}
