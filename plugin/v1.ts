// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

// opencode 1.x entry: `server(input)` returns hooks. Plugins start before any other service reads
// the config, and the `config` hook receives the merged config with the Markdown agents in it, so
// changes made there are what every agent uses (docs/research/opencode-v1.md, section 8).
//
// The shell guard needs the agent of the session that calls a tool, but `tool.execute.before`
// receives only the tool, session and call ids (opencode/src/session/tools.ts:106-110 at
// v1.18.35, identical at v1.19.0). A session's loop runs the agent of its latest user message
// (opencode/src/session/prompt.ts:1170), and opencode passes that agent to `chat.message` as
// `output.message.agent` when it creates the message (prompt.ts:662, :999-1009) and to
// `chat.params` before every model request (opencode/src/session/llm/request.ts:114-121). The
// plugin records it from both and, for a session it has not seen, asks the server, which keeps
// the same agent on the session record (prompt.ts:672-689).
//
// Helpers that answer in the user's own session (`/review`, `/progress`) get only their own
// request in each model request; see isolate.ts.
//
// The helper tools (tools-v1.ts) let lead see, redirect and stop its helpers. A message that
// lands in a helper's child session is pinned to that helper's agent, model and effort in
// `chat.message`, because the run takes them from the latest user message and the TUI sends
// lead's when the user types there (docs/research/background-helpers.md, section 7). The hook
// receives the message object that is then saved (prompt.ts:1000 and :1046 at v1.18.35).

import { applyToV1Config, planAgents, type AgentPlan } from "./apply.ts";
import { processEnvironment } from "./environment.ts";
import { checkShellCommand } from "./guard.ts";
import { Activity, HELPER_TOOL_IDS, pinMessage, toolCallBlock } from "./helpers.ts";
import { Compactions, isolateHelperRequest } from "./isolate.ts";
import { v1Reporter } from "./report.ts";
import { loadSettings, mergeSettings } from "./settings.ts";
import { v1Tools } from "./tools-v1.ts";
import type { EmbeddedHarness, Environment, Settings, V1Hooks, V1PluginInput } from "./types.ts";

/** opencode 1.x names its shell tool `bash` (opencode/src/tool/shell/id.ts). */
const SHELL_TOOL = "bash";
/** Built-in agents that make model requests inside a session but never call tools. */
const TOOL_LESS_AGENTS = new Set(["title", "summary", "compaction"]);
const LOOKUP_TIMEOUT_MS = 2000;
const MAX_SESSIONS = 5000;

export interface V1Options {
  environment?: () => Environment;
  schedule?: (run: () => void, ms: number) => void;
}

/** The project root: the git worktree, or the directory opencode runs in outside git (worktree "/"). */
export function v1ProjectRoot(input: V1PluginInput | undefined): string | undefined {
  const worktree = input?.worktree;
  if (typeof worktree === "string" && worktree !== "" && worktree !== "/") return worktree;
  return typeof input?.directory === "string" && input.directory !== "" ? input.directory : undefined;
}

/** Which agent each session runs, most recently seen last, and whether it is a child session. */
class SessionAgents {
  private readonly agents = new Map<string, string>();
  /** true: has a parent; false: has none. Looked up once per session. */
  private readonly children = new Map<string, boolean>();

  set(session: unknown, agent: unknown): void {
    if (typeof session !== "string" || typeof agent !== "string" || agent === "") return;
    this.agents.delete(session);
    this.agents.set(session, agent);
    if (this.agents.size > MAX_SESSIONS) {
      const oldest = this.agents.keys().next().value;
      if (oldest !== undefined) {
        this.agents.delete(oldest);
        this.children.delete(oldest);
      }
    }
  }

  get(session: string): string | undefined {
    return this.agents.get(session);
  }

  setChild(session: string, child: boolean): void {
    this.children.set(session, child);
  }

  isChild(session: string): boolean | undefined {
    return this.children.get(session);
  }
}

export function createServer(harness: EmbeddedHarness, options: V1Options = {}) {
  return async function server(input: V1PluginInput): Promise<V1Hooks> {
    const reporter = v1Reporter(harness.name, input?.client, options.schedule);
    let settings: Settings = mergeSettings([], harness);
    let plans: AgentPlan[] = [];
    let platform: string = process.platform;
    try {
      const environment = (options.environment ?? processEnvironment)();
      platform = environment.platform;
      const loaded = loadSettings(harness, environment, v1ProjectRoot(input));
      settings = loaded.settings;
      reporter.report(loaded.problems);
    } catch (error) {
      reporter.internal("reading the settings", error);
    }
    try {
      const planned = planAgents(harness, settings);
      plans = planned.plans;
      reporter.report(planned.problems);
    } catch (error) {
      reporter.internal("planning the agents", error);
    }

    const sessions = new SessionAgents();
    const helpers = new Set(harness.agents.filter((agent) => agent.mode === "subagent").map((agent) => agent.id));
    const compactions = new Compactions();
    const activity = new Activity();
    /** The session record from the server, within a short timeout; undefined when unavailable. */
    const fetchSession = async (session: string) => {
      const get = input?.client?.session?.get;
      if (typeof get !== "function") return undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), LOOKUP_TIMEOUT_MS);
        (timer as { unref?: () => void }).unref?.();
      });
      try {
        const result = await Promise.race([get.call(input.client?.session, { path: { id: session } }), timeout]);
        const data = result?.data;
        if (data === null || data === undefined) return undefined;
        if (typeof data.agent === "string") sessions.set(session, data.agent);
        sessions.setChild(session, typeof data.parentID === "string" && data.parentID !== "");
        return data;
      } finally {
        clearTimeout(timer);
      }
    };
    const lookup = async (session: string): Promise<string | undefined> => {
      const data = await fetchSession(session);
      return typeof data?.agent === "string" ? data.agent : undefined;
    };
    const isChild = async (session: string): Promise<boolean> => {
      const known = sessions.isChild(session);
      if (known !== undefined) return known;
      await fetchSession(session);
      return sessions.isChild(session) ?? false;
    };
    const tool = v1Tools({ harness, client: input?.client, agentOf: (session) => sessions.get(session), activity, plans, helpers });

    return {
      async config(config) {
        try {
          if (typeof config !== "object" || config === null) return;
          reporter.report(applyToV1Config(config, harness, settings, plans));
        } catch (error) {
          reporter.internal("the config hook", error);
        }
      },

      tool,

      async "chat.message"(message, output) {
        try {
          const session = message?.sessionID;
          const target = output?.message;
          if (typeof session === "string" && target !== undefined && target !== null) {
            // A message in a helper's child session runs as that helper, whoever sent it.
            const helper = sessions.get(session);
            const incoming = target.agent ?? message?.agent;
            if (helper !== undefined && helpers.has(helper) && incoming !== helper && (await isChild(session))) {
              pinMessage(target, helper, plans.find((plan) => plan.id === helper));
            }
          }
          sessions.set(session, output?.message?.agent ?? message?.agent);
        } catch (error) {
          reporter.internal("the chat.message hook", error);
        }
      },

      async "chat.params"(request) {
        try {
          if (!TOOL_LESS_AGENTS.has(request?.agent)) sessions.set(request?.sessionID, request?.agent);
        } catch (error) {
          reporter.internal("the chat.params hook", error);
        }
      },

      async "tool.execute.before"(call, output) {
        let message: string | undefined;
        try {
          if (HELPER_TOOL_IDS.includes(call?.tool)) {
            const agent = sessions.get(call.sessionID) ?? (await lookup(call.sessionID));
            message = toolCallBlock(harness, agent, call.tool);
          } else if (call?.tool === SHELL_TOOL) {
            const command = (output?.args as { command?: unknown } | undefined)?.command;
            if (typeof command === "string") {
              const agent = sessions.get(call.sessionID) ?? (await lookup(call.sessionID));
              message = checkShellCommand(harness, agent, command, platform)?.message;
            }
          }
          // A refused call is not a step the helper took.
          if (message === undefined) activity.note(call?.sessionID, call?.tool, output?.args);
        } catch (error) {
          reporter.internal("the tool guard", error);
          return;
        }
        // The one deliberate throw: opencode reports it to the model as the tool's error.
        if (message !== undefined) throw new Error(message);
      },

      async "experimental.session.compacting"(compaction) {
        try {
          compactions.mark(compaction?.sessionID);
        } catch (error) {
          reporter.internal("the compaction hook", error);
        }
      },

      async "experimental.chat.messages.transform"(_input, output) {
        try {
          const messages = output?.messages;
          if (!Array.isArray(messages) || messages.length === 0) return;
          if (compactions.take(messages[0]?.info?.sessionID)) return;
          isolateHelperRequest(messages, helpers);
        } catch (error) {
          reporter.internal("the message transform hook", error);
        }
      },
    };
  };
}
