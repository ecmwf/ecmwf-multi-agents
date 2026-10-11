// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

// opencode 2.0.16 entry: `setup(ctx)`. Agents come from transforms that run in registration
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
// The default agent is the opposite case: it is set by a transform registered during setup, so
// opencode's loader, which runs later, applies a `default_agent` from a config file over it.

import { applyToV2Agents, planAgents, type AgentPlan } from "./apply.ts";
import { processEnvironment } from "./environment.ts";
import { v2Reporter, type Reporter } from "./report.ts";
import { loadSettings, mergeSettings } from "./settings.ts";
import type { EmbeddedHarness, Environment, Settings, V2AgentEditor, V2Cleanup, V2Context, V2Registration } from "./types.ts";

/** Registers anyway when no `plugin.updated` arrives, in case the first one came before the subscription. */
export const FALLBACK_MS = 3000;

export interface V2Options {
  environment?: () => Environment;
  write?: (line: string) => void;
  fallbackMs?: number;
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

function watchActivations(ctx: V2Context, onActivation: () => void, reporter: Reporter, fallbackMs: number): () => void {
  const controller = new AbortController();
  let seen = false;
  const subscribe = ctx.event?.subscribe;
  if (typeof subscribe === "function") {
    void (async () => {
      for await (const event of subscribe.call(ctx.event, { signal: controller.signal })) {
        if (controller.signal.aborted) return;
        if (event?.type !== "plugin.updated") continue;
        seen = true;
        onActivation();
      }
    })().catch((error: unknown) => {
      if (!controller.signal.aborted) reporter.internal("watching plugin activations", error);
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
    const reporter = v2Reporter(harness.name, options.write);
    try {
      let settings: Settings = mergeSettings([], harness);
      try {
        const environment = (options.environment ?? processEnvironment)();
        const loaded = loadSettings(harness, environment, v2ProjectRoot(ctx));
        settings = loaded.settings;
        reporter.report(loaded.problems);
      } catch (error) {
        reporter.internal("reading the settings", error);
      }
      const planned = planAgents(harness, settings);
      const plans: AgentPlan[] = planned.plans;
      reporter.report(planned.problems);

      if (settings.defaultAgent) {
        await ctx.agent.transform((editor) => {
          try {
            editor.default(harness.defaultAgent);
          } catch (error) {
            reporter.internal("the default agent transform", error);
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
      const stopWatching = watchActivations(ctx, () => void late.register(), reporter, options.fallbackMs ?? FALLBACK_MS);
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
