// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

// The helper tools on opencode 1.x, wired to the SDK client the plugin receives: children and
// status of a session, `prompt_async` on a child (with the child's agent, so the run keeps its
// prompt, permissions, model and effort: prompt.ts:646-654 at v1.18.35 resolve the rest from the
// agent) and `abort`. See docs/research/background-helpers.md, sections 3, 5 and 8.

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
  type HelperView,
  type SessionFacts,
} from "./helpers.ts";
import type { EmbeddedHarness, V1Client, V1SessionInfo, V1ToolContext, V1ToolDefinition } from "./types.ts";

export interface V1ToolDeps {
  harness: EmbeddedHarness;
  client: V1Client | undefined;
  /** The agent each known session runs (see v1.ts). */
  agentOf: (session: string) => string | undefined;
  activity: Activity;
  plans: readonly AgentPlan[];
  helpers: ReadonlySet<string>;
}

function fail(message: string): never {
  throw new Error(message);
}

function session(client: V1Client | undefined) {
  const api = client?.session;
  if (api?.children === undefined || api.status === undefined || api.promptAsync === undefined || api.abort === undefined || api.get === undefined) {
    fail("this opencode does not offer the session API the helper tools need");
  }
  return api as Required<NonNullable<V1Client["session"]>>;
}

/** Sessions with work in progress. */
async function busySessions(api: ReturnType<typeof session>): Promise<Set<string>> {
  const status = (await api.status())?.data ?? {};
  return new Set(Object.entries(status).filter(([, value]) => value?.type === "busy").map(([id]) => id));
}

function facts(info: V1SessionInfo | null | undefined, id: string, agentOf: V1ToolDeps["agentOf"]): SessionFacts | undefined {
  if (info === null || info === undefined) return undefined;
  const agent = typeof info.agent === "string" ? info.agent : agentOf(id);
  return { id, parentID: info.parentID, ...(agent === undefined ? {} : { agent }) };
}

export function v1Tools(deps: V1ToolDeps): Record<string, V1ToolDefinition> {
  const { harness, activity, helpers } = deps;
  const text = (args: Record<string, unknown>, key: string): string => {
    const value = args[key];
    if (typeof value !== "string" || value.trim() === "") fail(`${key} must be a non-empty string`);
    return value.trim();
  };

  const children = async (api: ReturnType<typeof session>, context: V1ToolContext) => {
    const list = (await api.children({ path: { id: context.sessionID } }))?.data ?? [];
    return list.filter((item): item is V1SessionInfo & { id: string } => typeof item?.id === "string");
  };

  const status: V1ToolDefinition = {
    description: TOOL_SPECS.status.description,
    args: TOOL_SPECS.status.args,
    async execute(_args, context) {
      const api = session(deps.client);
      const [list, busy] = await Promise.all([children(api, context), busySessions(api)]);
      const now = Date.now();
      const views: HelperView[] = list.map((item) => {
        const record = activity.get(item.id);
        const agent = (typeof item.agent === "string" ? item.agent : deps.agentOf(item.id)) ?? "helper";
        return {
          id: item.id,
          agent,
          title: typeof item.title === "string" ? item.title : "",
          state: busy.has(item.id) ? "running" : (record?.ended ?? "done"),
          steps: record?.steps ?? 0,
          startedAt: item.time?.created,
          updatedAt: record?.at ?? item.time?.updated,
          ...(record?.lastTool === undefined ? {} : { lastTool: record.lastTool }),
        };
      });
      return formatStatus(views, now);
    },
  };

  const steer: V1ToolDefinition = {
    description: TOOL_SPECS.steer.description,
    args: TOOL_SPECS.steer.args,
    async execute(args, context) {
      const id = text(args, "id");
      const message = text(args, "text");
      const api = session(deps.client);
      const target = facts((await api.get({ path: { id } }).catch(() => undefined))?.data, id, deps.agentOf);
      const problem = targetProblem(target, id, context.sessionID, helpers);
      if (problem !== undefined) return problem;
      const agent = target!.agent ?? "helper";
      if (!(await busySessions(api)).has(id)) return notRunningResult(agent, id, `task_id: ${JSON.stringify(id)}`);
      await api.promptAsync({ path: { id }, body: { agent, parts: [{ type: "text", text: steerText(message, harness.defaultAgent) }] } });
      return steeredResult(agent, id);
    },
  };

  const cancel: V1ToolDefinition = {
    description: TOOL_SPECS.cancel.description,
    args: TOOL_SPECS.cancel.args,
    async execute(args, context) {
      const id = text(args, "id");
      const api = session(deps.client);
      const busy = await busySessions(api);
      const targets: Array<{ agent: string; id: string }> = [];
      if (id === "all") {
        for (const item of await children(api, context)) {
          if (!busy.has(item.id)) continue;
          targets.push({ id: item.id, agent: (typeof item.agent === "string" ? item.agent : deps.agentOf(item.id)) ?? "helper" });
        }
      } else {
        const target = facts((await api.get({ path: { id } }).catch(() => undefined))?.data, id, deps.agentOf);
        const problem = targetProblem(target, id, context.sessionID, helpers);
        if (problem !== undefined) return problem;
        if (!busy.has(id)) return `${target!.agent ?? "helper"} ${id} is not running.`;
        targets.push({ id, agent: target!.agent ?? "helper" });
      }
      for (const target of targets) {
        await api.abort({ path: { id: target.id } });
        activity.end(target.id, "stopped");
      }
      return cancelledResult(targets);
    },
  };

  return { [HELPER_TOOLS.status]: status, [HELPER_TOOLS.steer]: steer, [HELPER_TOOLS.cancel]: cancel };
}
