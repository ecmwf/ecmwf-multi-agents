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
// receives the message object that is then saved (prompt.ts:1000 and :1046 at v1.18.35). The
// session record is updated before the hook runs (prompt.ts:672-689), so after a pin it names
// the sender; the plugin's own record of a session's agent therefore wins over the server's.
//
// Whether a session is a helper's child comes from the `session.created` event, whose
// `properties.info.parentID` names the parent (opencode/src/plugin/index.ts:259 passes every bus
// event to the hook; opencode's own run command reads the field the same way, cli/cmd/run.ts:703).
// A session created before the plugin started is asked of the server once. When the parent
// cannot be known, nothing is pinned: that is the behaviour before the helper tools existed,
// whereas pinning the user's own session would take it away from lead. The user's own session
// can itself start with a helper's message, because `/review` and `/progress` answer inline.

import { applyToV1Config, planAgents, type AgentPlan } from "./apply.ts";
import { processEnvironment } from "./environment.ts";
import { checkShellCommand } from "./guard.ts";
import { Activity, HELPER_TOOL_IDS, helperIds, pinMessage, remember, toolCallBlock } from "./helpers.ts";
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
    remember(this.agents, session, agent);
    for (const child of this.children.keys()) if (!this.agents.has(child)) this.children.delete(child);
  }

  get(session: string): string | undefined {
    return this.agents.get(session);
  }

  /** Record whether a session has a parent, once; the event and the server agree, so later calls do nothing. */
  setChild(session: string, child: boolean): void {
    if (!this.children.has(session)) this.children.set(session, child);
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
    const helpers = helperIds(harness);
    const compactions = new Compactions();
    const activity = new Activity();
    /**
     * The session record from the server, within a short timeout; undefined when unavailable. It
     * fills in what the plugin has not seen and never replaces a known agent (see the header).
     */
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
        if (typeof data.agent === "string" && sessions.get(session) === undefined) sessions.set(session, data.agent);
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
    /**
     * The helper that owns a child session the plugin has no record of (created before the plugin
     * started): the agent of the session's first message. Undefined when the server cannot be
     * asked or the first message is not a helper's.
     */
    const ownerOfChild = async (session: string): Promise<string | undefined> => {
      const messages = input?.client?.session?.messages;
      if (typeof messages !== "function") return undefined;
      const list = (await messages.call(input.client?.session, { path: { id: session } }))?.data ?? [];
      const first = list.find((item) => item?.info?.role === "user")?.info?.agent;
      return typeof first === "string" && helpers.has(first) ? first : undefined;
    };
    const tool = v1Tools({ harness, client: input?.client, agentOf: (session) => sessions.get(session), activity, helpers });

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

      async event(input) {
        try {
          const event = input?.event;
          if (event?.type === "session.created") {
            const info = event.properties?.info;
            if (typeof info?.id === "string") sessions.setChild(info.id, typeof info.parentID === "string" && info.parentID !== "");
          } else if (event?.type === "session.error") {
            activity.end(event.properties?.sessionID, "failed");
          }
        } catch (error) {
          reporter.internal("the event hook", error);
        }
      },

      async "chat.message"(message, output) {
        try {
          const session = message?.sessionID;
          const target = output?.message;
          if (typeof session === "string" && target !== undefined && target !== null) {
            let helper = sessions.get(session);
            if (sessions.isChild(session) === undefined) {
              // No session.created event seen: the session predates the plugin. Ask the server
              // once; for a child, its helper is the agent of its first message.
              try {
                await fetchSession(session);
                if (sessions.isChild(session) === true && (helper === undefined || !helpers.has(helper))) {
                  const owner = await ownerOfChild(session);
                  if (owner !== undefined) {
                    sessions.set(session, owner);
                    helper = owner;
                  }
                }
              } catch (error) {
                reporter.internal("looking up a session", error);
              }
            }
            if (helper !== undefined && helpers.has(helper) && sessions.isChild(session) === true) {
              // Every message in a helper's child session runs as that helper, with the helper's
              // model and effort, whoever sent it and whatever it names.
              pinMessage(target, helper, plans.find((plan) => plan.id === helper));
            }
          }
          // A new message starts a new run; an earlier stop or failure no longer describes it.
          activity.resume(session);
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
        if (HELPER_TOOL_IDS.includes(call?.tool)) {
          // Fail closed: a caller that cannot be verified is refused like any other non-lead caller.
          try {
            const agent = sessions.get(call.sessionID) ?? (await lookup(call.sessionID));
            message = toolCallBlock(harness, agent, call.tool);
          } catch (error) {
            reporter.internal("verifying the caller of a helper tool", error);
            message = toolCallBlock(harness, undefined, call.tool);
          }
        } else if (call?.tool === SHELL_TOOL) {
          try {
            const command = (output?.args as { command?: unknown } | undefined)?.command;
            if (typeof command === "string") {
              const agent = sessions.get(call.sessionID) ?? (await lookup(call.sessionID));
              message = checkShellCommand(harness, agent, command, platform)?.message;
            }
          } catch (error) {
            reporter.internal("the shell guard", error);
            return;
          }
        }
        try {
          // A refused call is not a step the helper took.
          if (message === undefined) activity.observe(call?.sessionID, call?.tool, output?.args);
        } catch (error) {
          reporter.internal("recording a tool call", error);
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
