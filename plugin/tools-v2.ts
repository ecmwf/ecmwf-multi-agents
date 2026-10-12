// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

// The helper tools on opencode 2.0.16. The plugin context offers `session.get`, `prompt` and
// `interrupt`, but no session list and no messages (@opencode/plugin 2.0.16, promise/session.ts,
// `SessionDomain`), so the children of a session and their state come from the event stream:
// `session.created` carries the parent and the agent, `session.execution.*` the state. The
// tracker only mirrors what the platform publishes; it starts and stops nothing.

import type { AgentPlan } from "./apply.ts";
import {
  Activity,
  HELPER_TOOLS,
  TOOL_SPECS,
  cancelledResult,
  formatStatus,
  notRunningResult,
  steerText,
  steeredResult,
  targetProblem,
  type HelperState,
  type HelperView,
  type SessionFacts,
} from "./helpers.ts";
import type { EmbeddedHarness, V2Context, V2Event, V2ToolContext, V2ToolInfo } from "./types.ts";

const MAX_TRACKED = 5000;

export interface TrackedSession {
  id: string;
  parentID?: string;
  agent?: string;
  title?: string;
  state: HelperState;
  startedAt: number;
  updatedAt: number;
}

/** Sessions as the event stream describes them. */
export class SessionTracker {
  private readonly sessions = new Map<string, TrackedSession>();

  /**
   * Feed one event; anything that is not a session event is ignored. The subscription yields
   * an envelope (`id`, `created`, `type`, `location`) with the payload under `data`.
   */
  observe(envelope: V2Event | undefined, now: number = Date.now()): void {
    if (typeof envelope?.type !== "string") return;
    const data = envelope.data;
    const event: V2Event = { ...envelope, ...(data !== null && typeof data === "object" ? (data as V2Event) : {}), type: envelope.type };
    const id = event.sessionID;
    if (typeof id !== "string" || id === "") return;
    switch (event.type) {
      case "session.created": {
        const created: TrackedSession = {
          id,
          state: "unknown",
          startedAt: now,
          updatedAt: now,
          ...(typeof event.parentID === "string" ? { parentID: event.parentID } : {}),
          ...(typeof event.agent === "string" ? { agent: event.agent } : {}),
          ...(typeof event.title === "string" ? { title: event.title } : {}),
        };
        this.sessions.delete(id);
        this.sessions.set(id, created);
        if (this.sessions.size > MAX_TRACKED) {
          const oldest = this.sessions.keys().next().value;
          if (oldest !== undefined) this.sessions.delete(oldest);
        }
        return;
      }
      case "session.execution.started":
        return this.update(id, "running", now);
      case "session.execution.succeeded":
        return this.update(id, "done", now);
      case "session.execution.failed":
        return this.update(id, "failed", now);
      case "session.execution.interrupted":
        return this.update(id, "stopped", now);
      case "session.renamed":
        if (typeof event.title === "string") this.update(id, undefined, now, event.title);
        return;
      case "session.agent.selected":
        if (typeof event.agent === "string") {
          const session = this.sessions.get(id);
          if (session !== undefined) session.agent = event.agent;
        }
        return;
      default:
        return;
    }
  }

  private update(id: string, state: HelperState | undefined, now: number, title?: string): void {
    const session = this.sessions.get(id) ?? { id, state: "unknown" as HelperState, startedAt: now, updatedAt: now };
    if (state !== undefined) session.state = state;
    if (title !== undefined) session.title = title;
    session.updatedAt = now;
    this.sessions.set(id, session);
  }

  get(id: string): TrackedSession | undefined {
    return this.sessions.get(id);
  }

  children(parent: string): TrackedSession[] {
    return [...this.sessions.values()].filter((session) => session.parentID === parent);
  }
}

export interface V2ToolDeps {
  harness: EmbeddedHarness;
  ctx: V2Context;
  tracker: SessionTracker;
  activity: Activity;
  plans: readonly AgentPlan[];
  helpers: ReadonlySet<string>;
}

function fail(message: string): never {
  throw new Error(message);
}

function sessionApi(ctx: V2Context) {
  const api = ctx.session;
  if (api?.get === undefined || api.prompt === undefined || api.interrupt === undefined) {
    fail("this opencode does not offer the session API the helper tools need");
  }
  return api as Required<NonNullable<V2Context["session"]>>;
}

/** The v2 tool definitions; `editor.add` takes each as it is. */
export function v2Tools(deps: V2ToolDeps): V2ToolInfo[] {
  const { harness, tracker, activity, helpers } = deps;
  const text = (args: Record<string, unknown>, key: string): string => {
    const value = args[key];
    if (typeof value !== "string" || value.trim() === "") fail(`${key} must be a non-empty string`);
    return value.trim();
  };
  const factsOf = async (id: string): Promise<SessionFacts | undefined> => {
    const tracked = tracker.get(id);
    if (tracked !== undefined) return { id, parentID: tracked.parentID, ...(tracked.agent === undefined ? {} : { agent: tracked.agent }) };
    const info = await sessionApi(deps.ctx).get({ sessionID: id }).catch(() => undefined);
    if (info === undefined || info === null) return undefined;
    return { id, parentID: info.parentID, ...(typeof info.agent === "string" ? { agent: info.agent } : {}) };
  };
  const view = (session: { id: string; agent?: string; title?: string; state: HelperState; startedAt: number; updatedAt: number }): HelperView => {
    const record = activity.get(session.id);
    // A cancel the plugin made counts at once; the stream's interrupted event follows.
    const state = session.state === "running" && record?.ended !== undefined && record.at >= session.updatedAt ? record.ended : session.state;
    return {
      id: session.id,
      agent: session.agent ?? "helper",
      title: session.title ?? "",
      state,
      steps: record?.steps ?? 0,
      startedAt: session.startedAt,
      updatedAt: session.updatedAt,
      ...(record?.lastTool === undefined ? {} : { lastTool: record.lastTool }),
    };
  };
  const define = (spec: (typeof TOOL_SPECS)[keyof typeof TOOL_SPECS], run: (args: Record<string, unknown>, context: V2ToolContext) => Promise<string>): V2ToolInfo => ({
    name: spec.id,
    description: spec.description,
    input: { type: "object", properties: spec.args, required: Object.keys(spec.args), additionalProperties: false },
    execute: async (input, context) => ({ content: await run(input ?? {}, context) }),
    // A direct tool in the model request; otherwise it would exist only through Code Mode.
    options: { codemode: false },
  });

  return [
    define(TOOL_SPECS.status, async (_args, context) => formatStatus(tracker.children(context.sessionID).map(view))),

    define(TOOL_SPECS.steer, async (args, context) => {
      const id = text(args, "id");
      const message = text(args, "text");
      const target = await factsOf(id);
      const problem = targetProblem(target, id, context.sessionID, helpers);
      if (problem !== undefined) return problem;
      const agent = target!.agent ?? "helper";
      if (tracker.get(id)?.state !== "running") return notRunningResult(agent, id, `sessionID: ${JSON.stringify(id)}`);
      await sessionApi(deps.ctx).prompt({ sessionID: id, text: steerText(message, harness.defaultAgent), delivery: "steer" });
      return steeredResult(agent, id);
    }),

    define(TOOL_SPECS.cancel, async (args, context) => {
      const id = text(args, "id");
      const targets: Array<{ agent: string; id: string }> = [];
      if (id === "all") {
        for (const child of tracker.children(context.sessionID)) {
          if (child.state === "running") targets.push({ id: child.id, agent: child.agent ?? "helper" });
        }
      } else {
        const target = await factsOf(id);
        const problem = targetProblem(target, id, context.sessionID, helpers);
        if (problem !== undefined) return problem;
        if (tracker.get(id)?.state !== "running") return `${target!.agent ?? "helper"} ${id} is not running.`;
        targets.push({ id, agent: target!.agent ?? "helper" });
      }
      for (const target of targets) {
        await sessionApi(deps.ctx).interrupt({ sessionID: target.id });
        activity.end(target.id, "stopped");
      }
      return cancelledResult(targets);
    }),
  ];
}

export const HELPER_TOOL_NAMES = [HELPER_TOOLS.status, HELPER_TOOLS.steer, HELPER_TOOLS.cancel] as const;
