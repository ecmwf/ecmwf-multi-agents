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
/** How long an admitted hand-off holds its slot when the plugin never learns that its helper started or ended. */
export const ADMITTED_MS = 120_000;

interface Admitted {
  /** The tool call's id, which `execute.after` repeats. */
  call: string;
  /** lead's session. */
  parent: string;
  at: number;
  /** The children lead's session had when the hand-off was admitted: none of them is its helper. */
  before: ReadonlySet<string>;
  /** The helper's session, once known. */
  child?: string;
  /** A continued helper: its slot is held until its run is seen, since it is idle until then. */
  resumed?: boolean;
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

  private async check(parent: string, call: string | undefined, target?: string): Promise<string | undefined> {
    const now = this.now();
    this.admitted = this.admitted.filter((entry) => now - entry.at < ADMITTED_MS);
    const children = await this.deps.children(parent);
    const byId = new Map(children.map((child) => [child.id, child]));
    const busy: BusySlot[] = [];
    const counted = new Set<string>();
    for (const child of children) {
      if (child.state !== "running" || (child.agent !== undefined && !this.deps.helpers.has(child.agent))) continue;
      busy.push({ id: child.id, ...(child.agent === undefined ? {} : { agent: child.agent }) });
      counted.add(child.id);
    }
    // An admitted hand-off whose helper the plugin has not seen yet takes the earliest new child,
    // so a helper opencode lists before its events arrive is not counted twice.
    const taken = new Set(this.admitted.flatMap((entry) => (entry.child === undefined ? [] : [entry.child])));
    const earliest = [...children].sort((a, b) => a.startedAt - b.startedAt);
    for (const entry of this.admitted) {
      if (entry.parent !== parent || entry.child !== undefined) continue;
      const match = earliest.find((child) => !taken.has(child.id) && !entry.before.has(child.id));
      if (match === undefined) continue;
      entry.child = match.id;
      taken.add(match.id);
    }
    this.admitted = this.admitted.filter((entry) => {
      const child = entry.child === undefined ? undefined : byId.get(entry.child);
      return entry.parent !== parent || child === undefined || entry.resumed === true || !ENDED.has(child.state);
    });
    for (const entry of this.admitted) {
      if (entry.parent !== parent) continue;
      if (entry.child === undefined) {
        busy.push({});
        continue;
      }
      if (counted.has(entry.child)) continue;
      const agent = byId.get(entry.child)?.agent;
      busy.push({ id: entry.child, ...(agent === undefined ? {} : { agent }) });
      counted.add(entry.child);
    }
    // Continuing a helper that already holds a slot adds nothing.
    if (target !== undefined && counted.has(target)) return undefined;
    if (busy.length >= this.deps.limit) return slotsFullResult(this.deps.harness.name, this.deps.limit, busy);
    this.admitted.push({
      call: call ?? `unnamed-${++this.unnamed}`,
      parent,
      at: now,
      before: new Set(byId.keys()),
      ...(target === undefined ? {} : { child: target, resumed: true }),
    });
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

  /** Feed one event: a new child takes an admitted hand-off's slot, and its run releases it. */
  observe(envelope: V2Event | undefined): void {
    const event = eventFields(envelope);
    const id = event?.sessionID;
    if (event === undefined || typeof id !== "string" || id === "") return;
    if (event.type === "session.created") {
      if (typeof event.parentID !== "string" || this.admitted.some((entry) => entry.child === id)) return;
      const entry = this.admitted.find((item) => item.parent === event.parentID && item.child === undefined);
      if (entry !== undefined) entry.child = id;
      return;
    }
    // From its first execution event on, the helper's own state counts.
    if (event.type?.startsWith("session.execution.") === true) this.admitted = this.admitted.filter((entry) => entry.child !== id);
  }
}
