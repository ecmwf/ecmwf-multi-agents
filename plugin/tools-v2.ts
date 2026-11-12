// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

// The helper tools on opencode 2. The plugin context's `session.list` takes a `parentID` filter
// (`ListFilter` in schema/src/session.ts, opencode 2.2.5 and 2.2.6), so a session's helpers come
// from opencode, also those started before opencode or the plugin restarted. Each listed session
// carries its state: `time.busy` (start of the latest run), `time.idle` (end of the latest
// finished run) and `outcome` (`Session.Info`, same file). Without the list, or when it fails,
// the children and their state come from the event stream: `session.created` carries the parent
// and the agent, `session.execution.*` the state. The tracker only mirrors what the platform
// publishes; it starts and stops nothing.

import {
  Activity,
  HELPER_TOOLS,
  TOOL_SPECS,
  cancelledResult,
  formatStatus,
  notRunningResult,
  remember,
  requiredText,
  steerText,
  steeredResult,
  targetProblem,
  unknownStateResult,
  type HelperState,
  type HelperView,
  type TargetSession,
} from "./helpers.ts";
import { unwrap } from "./register.ts";
import type { EmbeddedHarness, ToolContext, V2Context, V2Event, V2SessionInfo, V2ToolInfo } from "./types.ts";

/** Sessions asked for per page of `session.list`. */
export const LIST_PAGE = 100;
/** A stop for a list that never ends, far beyond any real number of helpers. */
const MAX_PAGES = 100;

export interface TrackedSession {
  id: string;
  parentID?: string;
  agent?: string;
  title?: string;
  state: HelperState;
  startedAt: number;
  updatedAt: number;
}

/** An event with the fields opencode sends under `data` lifted to the top; undefined without a type. */
export function eventFields(envelope: V2Event | undefined): V2Event | undefined {
  if (typeof envelope?.type !== "string") return undefined;
  const data = envelope.data;
  return { ...envelope, ...(data !== null && typeof data === "object" ? (data as V2Event) : {}), type: envelope.type };
}

/** Sessions as the event stream describes them. */
export class SessionTracker {
  private readonly sessions = new Map<string, TrackedSession>();

  /**
   * Feed one event; anything that is not a session event is ignored. The subscription yields
   * an envelope (`id`, `created`, `type`, `location`) with the payload under `data`; the event
   * types and fields are those of schema/src/session-event.ts at v2.0.16 (research, section 11).
   */
  observe(envelope: V2Event | undefined, now: number = Date.now()): void {
    const event = eventFields(envelope);
    if (event === undefined) return;
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
        remember(this.sessions, id, created);
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
    remember(this.sessions, id, session);
  }

  get(id: string): TrackedSession | undefined {
    return this.sessions.get(id);
  }

  /** Fill in the parent and agent of a session the stream announced only by its execution events. */
  complete(id: string, facts: { parentID?: string; agent?: string }): void {
    const session = this.sessions.get(id);
    if (session === undefined) return;
    if (session.parentID === undefined && facts.parentID !== undefined) session.parentID = facts.parentID;
    if (session.agent === undefined && facts.agent !== undefined) session.agent = facts.agent;
  }

  children(parent: string): TrackedSession[] {
    return [...this.sessions.values()].filter((session) => session.parentID === parent);
  }
}

/** A time opencode sent: milliseconds, or a date string. */
function millis(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * A session's state as opencode reports it, or undefined when the answer has no times. A run is
 * in progress while its start (`time.busy`) is later than the end of the last finished run
 * (`time.idle`); otherwise `outcome` says how that run ended, and a session that never ran is idle.
 */
export function reportedState(info: V2SessionInfo): HelperState | undefined {
  const time = info.time;
  if (time === null || typeof time !== "object") return undefined;
  const busy = millis(time.busy);
  const idle = millis(time.idle);
  if (busy !== undefined && (idle === undefined || busy > idle)) return "running";
  if (info.outcome === "succeeded") return "done";
  if (info.outcome === "failed") return "failed";
  if (info.outcome === "interrupted") return "stopped";
  return "idle";
}

/** A session as opencode reports it, in the tracker's shape; undefined without an id or times. */
export function reportedSession(info: unknown, now: number = Date.now()): TrackedSession | undefined {
  if (info === null || typeof info !== "object") return undefined;
  const session = info as V2SessionInfo;
  if (typeof session.id !== "string" || session.id === "") return undefined;
  const state = reportedState(session);
  if (state === undefined) return undefined;
  const created = millis(session.time?.created) ?? now;
  const updatedAt = state === "running" ? (millis(session.time?.busy) ?? now) : (millis(session.time?.idle) ?? millis(session.time?.updated) ?? created);
  return {
    id: session.id,
    state,
    startedAt: created,
    updatedAt,
    ...(typeof session.parentID === "string" ? { parentID: session.parentID } : {}),
    ...(typeof session.agent === "string" ? { agent: session.agent } : {}),
    ...(typeof session.title === "string" ? { title: session.title } : {}),
  };
}

/**
 * The children of `parent` as opencode lists them, every page; undefined when this opencode has
 * no session list or its answer cannot be read.
 */
export async function listedChildren(ctx: V2Context, parent: string): Promise<TrackedSession[] | undefined> {
  const list = ctx.session?.list;
  if (typeof list !== "function") return undefined;
  const children = new Map<string, TrackedSession>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const answer = (await list.call(ctx.session, cursor === undefined ? { parentID: parent, limit: LIST_PAGE } : { cursor, limit: LIST_PAGE })) as
      | { data?: unknown; cursor?: { next?: unknown } }
      | undefined;
    if (!Array.isArray(answer?.data)) return undefined;
    for (const info of answer.data) {
      const child = reportedSession(info);
      if (child?.parentID === parent && !children.has(child.id)) children.set(child.id, child);
    }
    const next = answer.cursor?.next;
    // A full page may be followed by more; opencode gives a next cursor after every page that is not empty.
    if (answer.data.length < LIST_PAGE || typeof next !== "string" || next === cursor) break;
    cursor = next;
  }
  return [...children.values()];
}

/** How long `session.wait` may take to answer for a session this opencode does not run. */
export const RUN_PROBE_MS = 100;

/**
 * Whether this opencode process runs the session now. A run cut off when opencode stopped keeps
 * its `time.busy` without a `time.idle`, and only `opencode serve --service` resumes such runs
 * when it starts again (`installRestartContinuity` in server/src/process.ts, opencode 2.2.5), so
 * the times alone can name a run that nothing runs. `session.wait` answers at once when the
 * process has no run for the session (`awaitIdle` in core/src/session/run-coordinator.ts) and
 * only when the run ends otherwise. Without `wait`, or when it fails, the run counts as running.
 */
export async function runsHere(ctx: V2Context, sessionID: string): Promise<boolean> {
  const wait = ctx.session?.wait;
  if (typeof wait !== "function") return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ended = wait.call(ctx.session, { sessionID }).then(
    () => true,
    () => false,
  );
  const late = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), RUN_PROBE_MS);
    (timer as { unref?: () => void }).unref?.();
  });
  const answer = await Promise.race([ended, late]);
  clearTimeout(timer);
  return !answer;
}

/** A session opencode reports running, as stopped when this opencode does not run it. */
async function confirmed(ctx: V2Context, session: TrackedSession): Promise<TrackedSession> {
  return session.state !== "running" || (await runsHere(ctx, session.id)) ? session : { ...session, state: "stopped" };
}

/** The children of `parent`: opencode's list, else what the event stream announced. */
export async function sessionChildren(ctx: V2Context, tracker: SessionTracker, parent: string): Promise<TrackedSession[]> {
  const listed = await listedChildren(ctx, parent).catch(() => undefined);
  if (listed === undefined) return tracker.children(parent);
  return Promise.all(listed.map((child) => confirmed(ctx, child)));
}

/** A session as opencode reports it, a run nothing runs counted as stopped. */
export async function confirmedSession(ctx: V2Context, info: unknown): Promise<TrackedSession | undefined> {
  const session = reportedSession(info);
  return session === undefined ? undefined : confirmed(ctx, session);
}

export interface V2ToolDeps {
  harness: EmbeddedHarness;
  ctx: V2Context;
  tracker: SessionTracker;
  activity: Activity;
  helpers: ReadonlySet<string>;
}

type SessionApi = Required<NonNullable<V2Context["session"]>>;

function sessionApi(ctx: V2Context): SessionApi {
  const api = ctx.session;
  if (api?.get === undefined || api.prompt === undefined || api.interrupt === undefined) {
    throw new Error("this opencode does not offer the session API the helper tools need");
  }
  return api as SessionApi;
}

/** The v2 tool definitions; `editor.add` takes each as it is. */
export function v2Tools(deps: V2ToolDeps): V2ToolInfo[] {
  const { harness, tracker, activity, helpers } = deps;
  /**
   * A session's state: the stream's, except that a cancel the plugin made counts at once, before
   * the stream's interrupted event arrives.
   */
  const stateOf = (session: TrackedSession): HelperState => {
    const record = activity.get(session.id);
    return session.state === "running" && record?.ended !== undefined && record.at >= session.updatedAt ? record.ended : session.state;
  };
  /**
   * The target as opencode reports it. Without its state there (an answer without times), the
   * tracker's state, the session's parent and agent completed from the server when the tracker
   * saw only execution events for it; a session neither knows a state for has an unknown state.
   */
  const targetOf = async (id: string): Promise<(TargetSession & { state: HelperState }) | undefined> => {
    const tracked = tracker.get(id);
    const info = unwrap<V2SessionInfo>(await sessionApi(deps.ctx).get({ sessionID: id }).catch(() => undefined));
    if (info === undefined || info === null) return tracked === undefined ? undefined : { parentID: tracked.parentID, agent: tracked.agent ?? "helper", state: stateOf(tracked) };
    const parentID = info.parentID ?? tracked?.parentID;
    const agent = typeof info.agent === "string" ? info.agent : (tracked?.agent ?? "helper");
    const reported = await confirmedSession(deps.ctx, info);
    if (tracked !== undefined) tracker.complete(id, { parentID, agent });
    if (reported !== undefined) return { parentID, agent, state: stateOf(reported) };
    return { parentID, agent, state: tracked === undefined ? "unknown" : stateOf(tracked) };
  };
  const children = (parent: string) => sessionChildren(deps.ctx, tracker, parent);
  const view = (session: TrackedSession): HelperView => {
    const record = activity.get(session.id);
    return {
      id: session.id,
      agent: session.agent ?? "helper",
      title: session.title ?? "",
      state: stateOf(session),
      steps: record?.steps ?? 0,
      startedAt: session.startedAt,
      updatedAt: session.updatedAt,
      ...(record?.lastTool === undefined ? {} : { lastTool: record.lastTool }),
    };
  };
  const define = (spec: (typeof TOOL_SPECS)[keyof typeof TOOL_SPECS], run: (args: Record<string, unknown>, context: ToolContext) => Promise<string>): V2ToolInfo => ({
    name: spec.id,
    description: spec.description,
    input: { type: "object", properties: spec.args, required: Object.keys(spec.args), additionalProperties: false },
    execute: async (input, context) => ({ content: await run(input ?? {}, context) }),
    // A direct tool in the model request; otherwise it would exist only through Code Mode.
    options: { codemode: false },
  });

  return [
    // The harness's helpers only; a child the tracker knows no agent for is kept.
    define(TOOL_SPECS.status, async (_args, context) =>
      formatStatus((await children(context.sessionID)).filter((child) => child.agent === undefined || helpers.has(child.agent)).map(view)),
    ),

    define(TOOL_SPECS.steer, async (args, context) => {
      const id = requiredText(args, "id");
      const message = requiredText(args, "text");
      const target = await targetOf(id);
      const problem = targetProblem(target, id, context.sessionID, helpers);
      if (problem !== undefined) return problem;
      const { agent, state } = target!;
      const continuation = `sessionID: ${JSON.stringify(id)}`;
      if (state === "unknown") return unknownStateResult(agent!, id, continuation);
      if (state !== "running") return notRunningResult(agent!, id, continuation);
      await sessionApi(deps.ctx).prompt({ sessionID: id, text: steerText(message, harness.defaultAgent), delivery: "steer" });
      return steeredResult(agent!, id);
    }),

    define(TOOL_SPECS.cancel, async (args, context) => {
      const id = requiredText(args, "id");
      const targets: Array<{ agent: string; id: string }> = [];
      if (id === "all") {
        // Only the harness's own helpers; a child of another kind is left to its owner.
        for (const child of await children(context.sessionID)) {
          const agent = child.agent ?? "helper";
          if (stateOf(child) === "running" && helpers.has(agent)) targets.push({ id: child.id, agent });
        }
      } else {
        const target = await targetOf(id);
        const problem = targetProblem(target, id, context.sessionID, helpers);
        if (problem !== undefined) return problem;
        if (target!.state !== "running") return `${target!.agent} ${id} is not running.`;
        targets.push({ id, agent: target!.agent! });
      }
      for (const target of targets) {
        await sessionApi(deps.ctx).interrupt({ sessionID: target.id });
        activity.end(target.id, "stopped");
      }
      return cancelledResult(targets);
    }),
  ];
}
