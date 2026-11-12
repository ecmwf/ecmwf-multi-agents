// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

// The `max_helper_slots` limit, enforced. lead's prompt says how many helpers may run at once;
// the plugin's `execute.before` tool hook (v2.ts) also refuses lead's hand-off while that many
// of its helpers hold a slot. A helper holds one while it runs, and a hand-off admitted here
// holds one from then until its helper's run ends, so several hand-offs in one step count one by
// one, and a check that read the children just before a run started still counts it. Continuing
// a running helper with its `sessionID` takes no new slot; continuing an idle one starts a run,
// so it takes one like a new hand-off. Only lead is limited.
//
// A hand-off learns its helper from its own call: opencode's delegation tool reports the child's
// `sessionID` as the call's progress right after creating it, which reaches plugins as a
// `session.tool.progress` event with the call's `id` (`Tool.Progress` in
// schema/src/session-event.ts, opencode 2.2.5), and again in the call's result. Until then the
// plugin guesses (the oldest waiting hand-off takes the next new child), and the call's own word
// corrects the guess. A guessed helper's run end does not free the slot: the hand-off keeps it
// until its call succeeds (naming its helper) or fails, or until ADMITTED_MS passes.

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
  /**
   * The child is the one this call created or continued, as opencode said; otherwise it is the
   * plugin's guess, which the call's own word corrects.
   */
  exact?: boolean;
  /** The helper's agent, as its creation announced it. */
  agent?: string;
  /** A continued helper: its slot is held until its run is seen, since it is idle until then. */
  resumed?: boolean;
  /** The number of the event that started the helper's run, once seen. */
  started?: number;
  /**
   * The guessed helper's run has ended. The slot stays held until the call itself answers, since
   * the guess may be wrong and the call's own helper may still be to come.
   */
  ended?: boolean;
}

export interface SlotDeps {
  harness: EmbeddedHarness;
  limit: number;
  helpers: ReadonlySet<string>;
  /** The children of a session with their state: opencode's list, else the event tracker. */
  children: (parent: string) => Promise<TrackedSession[]>;
  now?: () => number;
}

/** A member of an object, if there is one. */
function member(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
}

/** A session id, if the value is one. */
function sessionText(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * The child a hand-off's own word names: the `metadata` of its progress update and of its
 * result, and the `output` of its result, carry the child's `sessionID` (`SubagentTool` in
 * core/src/tool/plugin/subagent.ts, opencode 2.2.5).
 */
function namedChild(result: unknown): string | undefined {
  return sessionText(member(member(result, "metadata"), "sessionID")) ?? sessionText(member(member(result, "output"), "sessionID"));
}

/** The helper a call continues, if it names one: opencode drops an empty `sessionID`. */
function continued(input: unknown): string | undefined {
  return sessionText(member(input, "sessionID"));
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

  /**
   * The call's own word: `child` is the helper this hand-off created. A hand-off that was guessed
   * to own it gives it up, and the helper this one was guessed to own goes back to the pool.
   */
  private bind(entry: Admitted, child: string): void {
    if (entry.exact === true) return;
    entry.at = this.now();
    if (entry.child === child) {
      entry.exact = true;
      this.settle(entry);
      return;
    }
    const holder = this.admitted.find((item) => item !== entry && item.child === child);
    if (holder?.exact === true) return;
    const given = { child: entry.child, agent: entry.agent, started: entry.started, ended: entry.ended };
    entry.agent = holder?.agent;
    entry.started = holder?.started;
    entry.ended = holder?.ended;
    entry.exact = true;
    this.own(entry, child);
    if (holder !== undefined) {
      holder.child = undefined;
      holder.agent = undefined;
      holder.started = undefined;
      holder.ended = undefined;
    }
    if (given.child !== undefined) this.release(entry.parent, given.child, given.agent, given.started, given.ended);
    this.settle(entry);
  }

  /** An exactly paired hand-off whose helper's run was already seen to end frees its slot. */
  private settle(entry: Admitted): void {
    if (entry.exact === true && entry.ended === true) this.admitted = this.admitted.filter((item) => item !== entry);
  }

  /** A helper no hand-off owns any more goes to the oldest hand-off still waiting for one that could have created it. */
  private release(parent: string, child: string, agent: string | undefined, started: number | undefined, ended: boolean | undefined): void {
    const taker = this.admitted.find((item) => item.parent === parent && item.child === undefined && item.resumed !== true && !item.before.has(child));
    if (taker === undefined) {
      this.owned.delete(child);
      return;
    }
    this.own(taker, child);
    taker.agent = agent;
    taker.started = started;
    taker.ended = ended;
    taker.at = this.now();
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
    // An admitted hand-off whose helper the plugin has not seen yet is guessed to own the earliest
    // new child that no hand-off owns or owned, so a helper opencode lists before its events
    // arrive is not counted twice and never stands for two hand-offs.
    const earliest = [...children].sort((a, b) => a.startedAt - b.startedAt);
    for (const entry of this.admitted) {
      if (entry.parent !== parent || entry.child !== undefined) continue;
      const match = earliest.find((child) => !this.owned.has(child.id) && !entry.before.has(child.id) && !ENDED.has(child.state));
      if (match !== undefined) this.own(entry, match.id);
    }
    // A snapshot shows a helper's run ended only if it was read after that run was seen to start.
    for (const entry of this.admitted) {
      const child = entry.parent !== parent || entry.child === undefined ? undefined : byId.get(entry.child);
      if (child !== undefined && entry.started !== undefined && entry.started <= seen && ENDED.has(child.state)) entry.ended = true;
    }
    this.admitted = this.admitted.filter((entry) => entry.exact !== true || entry.ended !== true);
    for (const entry of this.admitted) {
      if (entry.parent !== parent) continue;
      // A guessed helper that has ended stands for a hand-off whose own helper may still come.
      if (entry.child === undefined || entry.ended === true) {
        busy.push({});
        continue;
      }
      if (counted.has(entry.child)) continue;
      const agent = byId.get(entry.child)?.agent ?? entry.agent;
      busy.push({ id: entry.child, ...(agent === undefined ? {} : { agent }) });
      counted.add(entry.child);
    }
    // Continuing a helper that already holds a slot needs no free one, but every admitted call has
    // its own entry, so one call's failure releases only its own hold on the helper.
    if ((target === undefined || !counted.has(target)) && busy.length >= this.deps.limit) return slotsFullResult(this.deps.harness.name, this.deps.limit, busy);
    const entry: Admitted = { call: call ?? `unnamed-${++this.unnamed}`, parent, at: now, before: new Set(byId.keys()) };
    if (target !== undefined) {
      entry.resumed = true;
      entry.exact = true;
      this.own(entry, target);
      // A running helper takes the continuation into its run, so the end of that run ends it.
      if (byId.get(target)?.state === "running") entry.started = seen;
      else {
        const sibling = this.admitted.find((item) => item.child === target && item.started !== undefined);
        if (sibling !== undefined) entry.started = sibling.started;
      }
    }
    this.admitted.push(entry);
    return undefined;
  }

  /**
   * A hand-off has returned. One that failed frees its slot at once, and a helper it was only
   * guessed to own goes back to the pool; a background one that succeeded keeps its slot until
   * its helper's run ends, and its result names that helper.
   */
  ended(call: V2ToolCall | undefined): void {
    if (call?.tool !== DELEGATION_TOOL || typeof call.id !== "string") return;
    const entry = this.admitted.find((item) => item.call === call.id);
    if (entry === undefined) return;
    if (call.status === "error") {
      this.admitted = this.admitted.filter((item) => item !== entry);
      if (entry.child !== undefined && entry.exact !== true) this.release(entry.parent, entry.child, entry.agent, entry.started, entry.ended);
      return;
    }
    const child = namedChild(call.result);
    if (child !== undefined) this.bind(entry, child);
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
    if (event.type === "session.tool.progress") {
      const entry = typeof event.id === "string" ? this.admitted.find((item) => item.call === event.id) : undefined;
      const child = namedChild(event);
      if (entry !== undefined && child !== undefined) this.bind(entry, child);
      return;
    }
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
      // A guessed pairing waits for its call to answer; an exact one frees the slot now.
      for (const entry of mine) if (entry.resumed !== true || entry.started !== undefined) entry.ended = true;
      this.admitted = this.admitted.filter((entry) => entry.exact !== true || entry.ended !== true);
      return;
    }
    for (const entry of mine) {
      entry.at = this.now();
      if (event.type === "session.execution.started") entry.started = number;
    }
  }
}
