// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

// The helper tools on opencode 1.x, wired to the SDK client the plugin receives: children and
// status of a session, `prompt_async` on a child, and `abort`. A steer names only the child's
// agent: opencode fills in that agent's model and effort (prompt.ts:646-654 at v1.18.35). See
// docs/research/background-helpers.md, sections 3, 5 and 8.
//
// The agent of a child comes from the plugin's own record first (v1.ts, fed by the chat hooks)
// and from the server's session record only for sessions the plugin has not seen: after a pinned
// message the server record names the sender, lead, while the run is the helper's (section 7).
//
// One race the code cannot close: a helper that finishes between the busy check and the steer
// gets a plain new run, which wakes nobody; the status tool shows it, and lead reads the result
// on its next turn.

import {
  Activity,
  HELPER_TOOLS,
  TOOL_SPECS,
  cancelledResult,
  formatStatus,
  notRunningResult,
  requiredText,
  steerText,
  steeredResult,
  targetProblem,
  type HelperView,
  type TargetSession,
} from "./helpers.ts";
import type { EmbeddedHarness, ToolContext, V1Client, V1SessionInfo, V1ToolDefinition } from "./types.ts";

export interface V1ToolDeps {
  harness: EmbeddedHarness;
  client: V1Client | undefined;
  /** The agent a known session runs, from the chat hooks. */
  agentOf: (session: string) => string | undefined;
  activity: Activity;
  helpers: ReadonlySet<string>;
}

type SessionApi = Required<NonNullable<V1Client["session"]>>;

function sessionApi(client: V1Client | undefined): SessionApi {
  const api = client?.session;
  if (api?.children === undefined || api.status === undefined || api.promptAsync === undefined || api.abort === undefined || api.get === undefined) {
    throw new Error("this opencode does not offer the session API the helper tools need");
  }
  return api as SessionApi;
}

/** Sessions with work in progress. */
async function busySessions(api: SessionApi): Promise<Set<string>> {
  const status = (await api.status())?.data ?? {};
  return new Set(Object.entries(status).filter(([, value]) => value?.type === "busy").map(([id]) => id));
}

export function v1Tools(deps: V1ToolDeps): Record<string, V1ToolDefinition> {
  const { harness, activity, helpers } = deps;
  const agentOf = (id: string, info?: V1SessionInfo | null): string => deps.agentOf(id) ?? (typeof info?.agent === "string" ? info.agent : "helper");
  const targetOf = async (api: SessionApi, id: string): Promise<TargetSession | undefined> => {
    const info = (await api.get({ path: { id } }).catch(() => undefined))?.data;
    if (info === null || info === undefined) return undefined;
    return { parentID: info.parentID, agent: agentOf(id, info) };
  };
  const children = async (api: SessionApi, context: ToolContext) => {
    const list = (await api.children({ path: { id: context.sessionID } }))?.data ?? [];
    return list.filter((item): item is V1SessionInfo & { id: string } => typeof item?.id === "string");
  };

  const status: V1ToolDefinition = {
    description: TOOL_SPECS.status.description,
    args: TOOL_SPECS.status.args,
    async execute(_args, context) {
      const api = sessionApi(deps.client);
      const [list, busy] = await Promise.all([children(api, context), busySessions(api)]);
      const views: HelperView[] = list.map((item) => {
        const record = activity.get(item.id);
        return {
          id: item.id,
          agent: agentOf(item.id, item),
          title: typeof item.title === "string" ? item.title : "",
          state: busy.has(item.id) ? "running" : (record?.ended ?? "done"),
          steps: record?.steps ?? 0,
          startedAt: item.time?.created,
          updatedAt: record?.at ?? item.time?.updated,
          ...(record?.lastTool === undefined ? {} : { lastTool: record.lastTool }),
        };
      });
      return formatStatus(views);
    },
  };

  const steer: V1ToolDefinition = {
    description: TOOL_SPECS.steer.description,
    args: TOOL_SPECS.steer.args,
    async execute(args, context) {
      const id = requiredText(args, "id");
      const message = requiredText(args, "text");
      const api = sessionApi(deps.client);
      const target = await targetOf(api, id);
      const problem = targetProblem(target, id, context.sessionID, helpers);
      if (problem !== undefined) return problem;
      const agent = target!.agent!;
      if (!(await busySessions(api)).has(id)) return notRunningResult(agent, id, `task_id: ${JSON.stringify(id)}`);
      await api.promptAsync({ path: { id }, body: { agent, parts: [{ type: "text", text: steerText(message, harness.defaultAgent) }] } });
      return steeredResult(agent, id);
    },
  };

  const cancel: V1ToolDefinition = {
    description: TOOL_SPECS.cancel.description,
    args: TOOL_SPECS.cancel.args,
    async execute(args, context) {
      const id = requiredText(args, "id");
      const api = sessionApi(deps.client);
      const busy = await busySessions(api);
      const targets: Array<{ agent: string; id: string }> = [];
      if (id === "all") {
        // Only the harness's own helpers; a child of another kind is left to its owner.
        for (const item of await children(api, context)) {
          const agent = agentOf(item.id, item);
          if (busy.has(item.id) && helpers.has(agent)) targets.push({ id: item.id, agent });
        }
      } else {
        const target = await targetOf(api, id);
        const problem = targetProblem(target, id, context.sessionID, helpers);
        if (problem !== undefined) return problem;
        if (!busy.has(id)) return `${target!.agent} ${id} is not running.`;
        targets.push({ id, agent: target!.agent! });
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
