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

import { applyToV1Config, planAgents, type AgentPlan } from "./apply.ts";
import { processEnvironment } from "./environment.ts";
import { checkShellCommand } from "./guard.ts";
import { Compactions, isolateHelperRequest } from "./isolate.ts";
import { v1Reporter } from "./report.ts";
import { loadSettings, mergeSettings } from "./settings.ts";
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

/** Which agent each session runs, most recently seen last. */
class SessionAgents {
  private readonly agents = new Map<string, string>();

  set(session: unknown, agent: unknown): void {
    if (typeof session !== "string" || typeof agent !== "string" || agent === "") return;
    this.agents.delete(session);
    this.agents.set(session, agent);
    if (this.agents.size > MAX_SESSIONS) {
      const oldest = this.agents.keys().next().value;
      if (oldest !== undefined) this.agents.delete(oldest);
    }
  }

  get(session: string): string | undefined {
    return this.agents.get(session);
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
    const lookup = async (session: string): Promise<string | undefined> => {
      const get = input?.client?.session?.get;
      if (typeof get !== "function") return undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), LOOKUP_TIMEOUT_MS);
        (timer as { unref?: () => void }).unref?.();
      });
      try {
        const result = await Promise.race([get.call(input.client?.session, { path: { id: session } }), timeout]);
        const agent = result?.data?.agent;
        if (typeof agent === "string") sessions.set(session, agent);
        return typeof agent === "string" ? agent : undefined;
      } finally {
        clearTimeout(timer);
      }
    };

    return {
      async config(config) {
        try {
          if (typeof config !== "object" || config === null) return;
          reporter.report(applyToV1Config(config, harness, settings, plans));
        } catch (error) {
          reporter.internal("the config hook", error);
        }
      },

      async "chat.message"(message, output) {
        try {
          sessions.set(message?.sessionID, output?.message?.agent ?? message?.agent);
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
        let block: ReturnType<typeof checkShellCommand>;
        try {
          if (call?.tool !== SHELL_TOOL) return;
          const command = (output?.args as { command?: unknown } | undefined)?.command;
          if (typeof command !== "string") return;
          const agent = sessions.get(call.sessionID) ?? (await lookup(call.sessionID));
          block = checkShellCommand(harness, agent, command, platform);
        } catch (error) {
          reporter.internal("the shell guard", error);
          return;
        }
        // The one deliberate throw: opencode reports it to the model as the tool's error.
        if (block !== undefined) throw new Error(block.message);
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
