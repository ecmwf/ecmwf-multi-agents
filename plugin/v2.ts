// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

// opencode 2 entry: `setup(ctx)`. It first registers the harness itself (register.ts): agents,
// skills, commands and lead as the default agent, which opencode's loaders for files and config
// then override, and the RPC (rpc.ts). The rest adjusts and extends what is registered.
//
// Agents come from transforms that run in registration
// order on every rebuild. User plugins activate before opencode's own loader for agent files and
// config, and a transform registered during setup therefore runs before the agent files load and
// loses every field they set (docs/research/opencode-v2.md, section 6).
//
// So the profile, overrides and review policy go into a transform registered after activation.
// opencode publishes `plugin.updated` at the end of every activation, after the loader has
// registered (core/src/plugin.ts:121 and :175 at v2.0.16). The plugin registers its transform on
// that event and registers it again on each later one: an activation that reloads plugins after
// this one re-registers the loader behind it, and a fresh registration goes to the end of the
// list (transforms are kept in insertion order, core/src/state.ts:162, :178, :242). The new
// registration is added before the old one is removed, so the agents never show the file values
// in between. Agent file and config changes rerun the transforms in place and keep the order
// (core/src/config/plugin/agent.ts:55-58).
//
// The default agent is the opposite case: it is set by the registration transform during setup,
// so opencode's loader, which runs later, applies a `default_agent` from a config file over it.
//
// The helper tools (tools-v2.ts) are added by a tool transform registered during setup, which
// is enough: nothing later removes a tool another plugin added. The `execute.before` hook
// refuses a helper's call to them and feeds the activity tracker; the event subscription feeds
// the session tracker besides watching for activations.
//
// The `context` session hook leaves a background helper's report that arrives while lead is still
// replying to the user out of lead's requests until the reply has ended, and a message queued for
// after the turn wakes lead to act on it; see answer-first.ts.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { heldReportsV2, WAKE_TEXT } from "./answer-first.ts";
import { applyToV2Agents, planAgents, type AgentPlan } from "./apply.ts";
import { processEnvironment } from "./environment.ts";
import { Activity, helperIds, toolCallBlock } from "./helpers.ts";
import { registerHarness } from "./register.ts";
import { v2Reporter, type Reporter } from "./report.ts";
import { ProblemLog, registerRpc } from "./rpc.ts";
import { loadSettings, mergeSettings, type LoadedSettings } from "./settings.ts";
import { SessionTracker, v2Tools } from "./tools-v2.ts";
import type { EmbeddedHarness, Environment, Settings, V2AgentEditor, V2Cleanup, V2Context, V2Event, V2Registration } from "./types.ts";

/** Registers anyway when no `plugin.updated` arrives, in case the first one came before the subscription. */
export const FALLBACK_MS = 3000;

export interface V2Options {
  environment?: () => Environment;
  write?: (line: string) => void;
  fallbackMs?: number;
  /** The folder of the plugin's entry file; skills are registered at their files next to it. */
  pluginDir?: string;
}

/** The folder this module runs from: the plugin folder once bundled. */
function moduleDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

/** The project root: the worktree of the project opencode resolved, else the directory it runs in. */
export function v2ProjectRoot(ctx: V2Context | undefined): string | undefined {
  const project = ctx?.location?.project?.directory;
  if (typeof project === "string" && project !== "") return project;
  const directory = ctx?.location?.directory;
  return typeof directory === "string" && directory !== "" ? directory : undefined;
}

/** One transform kept at the end of the list by registering it again. */
class LateTransform {
  private current: V2Registration | undefined;
  private queue: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(
    private readonly ctx: V2Context,
    private readonly callback: (editor: V2AgentEditor) => void,
    private readonly reporter: Reporter,
  ) {}

  register(): Promise<void> {
    this.queue = this.queue.then(async () => {
      if (this.stopped) return;
      try {
        const next = await this.ctx.agent.transform(this.callback);
        const previous = this.current;
        this.current = next;
        if (previous !== undefined) await previous.dispose();
      } catch (error) {
        if (!this.stopped) this.reporter.internal("registering the agent transform", error);
      }
    });
    return this.queue;
  }

  /** Stop registering. Registrations end with the plugin's scope when opencode unloads it. */
  stop(): void {
    this.stopped = true;
  }
}

function watchEvents(ctx: V2Context, onActivation: () => void, onEvent: (event: V2Event) => void, reporter: Reporter, fallbackMs: number): () => void {
  const controller = new AbortController();
  let seen = false;
  const subscribe = ctx.event?.subscribe;
  if (typeof subscribe === "function") {
    void (async () => {
      for await (const event of subscribe.call(ctx.event, { signal: controller.signal })) {
        if (controller.signal.aborted) return;
        if (event?.type === "plugin.updated") {
          seen = true;
          onActivation();
          continue;
        }
        try {
          onEvent(event);
        } catch (error) {
          reporter.internal("reading an event", error);
        }
      }
    })().catch((error: unknown) => {
      if (!controller.signal.aborted) reporter.internal("watching events", error);
    });
  }
  const timer = setTimeout(() => {
    if (!seen && !controller.signal.aborted) onActivation();
  }, fallbackMs);
  (timer as { unref?: () => void }).unref?.();
  return () => {
    controller.abort();
    clearTimeout(timer);
  };
}

export function createSetup(harness: EmbeddedHarness, options: V2Options = {}) {
  return async function setup(ctx: V2Context): Promise<V2Cleanup | undefined> {
    const problems = new ProblemLog();
    const reporter = v2Reporter(harness.name, options.write, (problem) => problems.add(problem));
    try {
      let environment: Environment | undefined;
      let loaded: LoadedSettings = { settings: mergeSettings([], harness), problems: [], applied: [], sources: {} };
      try {
        environment = (options.environment ?? processEnvironment)();
        loaded = loadSettings(harness, environment, v2ProjectRoot(ctx));
      } catch (error) {
        reporter.internal("reading the settings", error);
      }
      const settings: Settings = loaded.settings;

      await registerHarness(ctx, harness, {
        home: environment?.home ?? "",
        pluginDir: options.pluginDir ?? moduleDir(),
        defaultAgent: settings.defaultAgent,
        reporter,
      });
      if (environment !== undefined) {
        try {
          await registerRpc({
            harness,
            ctx,
            loaded,
            problems,
            environment,
            directory: ctx.location?.directory,
            projectRoot: v2ProjectRoot(ctx),
          });
        } catch (error) {
          reporter.internal("registering the RPC", error);
        }
      }

      reporter.report(loaded.problems);
      const planned = planAgents(harness, settings);
      const plans: AgentPlan[] = planned.plans;
      reporter.report(planned.problems);

      const helpers = helperIds(harness);
      const tracker = new SessionTracker();
      const activity = new Activity();
      if (typeof ctx.tool?.transform === "function") {
        const tools = v2Tools({ harness, ctx, tracker, activity, helpers });
        await ctx.tool.transform((editor) => {
          try {
            for (const tool of tools) editor.add(tool);
          } catch (error) {
            reporter.internal("the tool transform", error);
          }
        });
      }
      if (typeof ctx.tool?.hook === "function") {
        await ctx.tool.hook("execute.before", (call) => {
          let message: string | undefined;
          try {
            message = toolCallBlock(harness, call?.agent, call?.tool);
            // A refused call is not a step the helper took.
            if (message === undefined) activity.observe(call?.sessionID, call?.tool, call?.input);
          } catch (error) {
            reporter.internal("the tool guard", error);
            return;
          }
          // The one deliberate throw: opencode refuses the call and tells the model why.
          if (message !== undefined) throw new Error(message);
        });
      }
      if (typeof ctx.session?.hook === "function") {
        /** Replies whose held reports already have a wake queued, by session and request. */
        const woken = new Set<string>();
        await ctx.session.hook("context", async (event) => {
          // A session hook that throws cannot fail cleanly (core/src/plugin/hooks.ts:23-28).
          try {
            if (event?.agent !== harness.defaultAgent || !Array.isArray(event.messages)) return;
            const found = heldReportsV2(event.messages);
            if (found === undefined) return;
            const sessionID = event.sessionID;
            const key = `${sessionID}\n${found.reply}`;
            if (!woken.has(key)) {
              // Without a queued wake nothing would deliver the reports again: leave them in view.
              if (typeof sessionID !== "string" || typeof ctx.session?.synthetic !== "function") return;
              await ctx.session.synthetic({ sessionID, text: WAKE_TEXT, description: "Reports held until lead answered", delivery: "queue" });
              woken.add(key);
            }
            for (const index of [...found.held].reverse()) event.messages.splice(index, 1);
          } catch (error) {
            reporter.internal("the context hook", error);
          }
        });
      }

      const late = new LateTransform(
        ctx,
        (editor) => {
          // Runs on every rebuild; opencode disables a plugin whose transform throws.
          try {
            reporter.report(applyToV2Agents(editor, harness, settings, plans));
          } catch (error) {
            reporter.internal("the agent transform", error);
          }
        },
        reporter,
      );
      const stopWatching = watchEvents(ctx, () => void late.register(), (event) => tracker.observe(event), reporter, options.fallbackMs ?? FALLBACK_MS);
      return async () => {
        stopWatching();
        late.stop();
      };
    } catch (error) {
      reporter.internal("setup", error);
      return undefined;
    }
  };
}
