// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { createPlugin } from "./plugin.ts";
import { LEAD_PROMPT, embeddedFixture, fakeEnvironment } from "./testing.ts";
import type { V2AgentEditor, V2AgentInfo, V2Context } from "./types.ts";
import { v2ProjectRoot } from "./v2.ts";

const harness = embeddedFixture();
const GLOBAL = "/home/user/.config/opencode/ecmwf-multi-agents.jsonc";
const PROJECT = "/repo/.opencode/ecmwf-multi-agents.jsonc";

/**
 * A stand-in for opencode 2.0.16's agent state: transforms run in registration order on every
 * rebuild, starting from an empty state; `plugin.updated` events go to subscribers.
 */
class FakeHost {
  /** Registrations in order; each is its own entry, as in opencode (core/src/state.ts). */
  transforms: Array<(editor: V2AgentEditor) => void> = [];
  private listeners = new Set<(event: { type: string }) => void>();
  subscriptions = 0;

  readonly ctx: V2Context = {
    location: { directory: "/repo/sub", project: { directory: "/repo" } },
    agent: {
      transform: async (callback) => {
        const entry = (editor: V2AgentEditor) => callback(editor);
        this.transforms.push(entry);
        this.build();
        return {
          dispose: async () => {
            this.transforms = this.transforms.filter((item) => item !== entry);
          },
        };
      },
    },
    event: {
      subscribe: (options) => this.subscribe(options?.signal),
    },
  };

  /** opencode's loader for agent files and config: a later ("post") registration. */
  loader(defaultAgent?: string): (editor: V2AgentEditor) => void {
    const load = (editor: V2AgentEditor) => {
      if (defaultAgent !== undefined) editor.default(defaultAgent);
      editor.update("lead", (agent) => Object.assign(agent, { mode: "primary", system: LEAD_PROMPT, model: { id: "claude-opus-5-5", providerID: "anthropic", variant: "xhigh" } }));
      editor.update("reviewer", (agent) => Object.assign(agent, { mode: "subagent", steps: 30, model: { id: "gpt-6.1-sol", providerID: "github-copilot", variant: "medium" } }));
      editor.update("scout", (agent) => Object.assign(agent, { mode: "subagent", steps: 15, model: { id: "claude-sonnet-5-5", providerID: "anthropic", variant: "medium" } }));
    };
    this.transforms.push(load);
    return load;
  }

  build(): { agents: Map<string, V2AgentInfo>; default?: string } {
    const state: { agents: Map<string, V2AgentInfo>; default?: string } = { agents: new Map() };
    state.agents.set("build", { id: "build", mode: "primary", hidden: false });
    const editor: V2AgentEditor = {
      list: () => [...state.agents.values()],
      get: (id) => state.agents.get(id),
      default: (id) => {
        state.default = id;
      },
      update: (id, update) => {
        const agent = state.agents.get(id) ?? { id, mode: "primary", hidden: false };
        state.agents.set(id, agent);
        update(agent);
      },
    };
    for (const transform of this.transforms) transform(editor);
    return state;
  }

  emit(type: string): void {
    for (const listener of this.listeners) listener({ type });
  }

  private subscribe(signal: AbortSignal | undefined): AsyncIterable<{ type: string }> {
    const queue: Array<{ type: string }> = [];
    let wake: (() => void) | undefined;
    const listener = (event: { type: string }) => {
      queue.push(event);
      wake?.();
    };
    this.listeners.add(listener);
    this.subscriptions++;
    const listeners = this.listeners;
    return {
      async *[Symbol.asyncIterator]() {
        try {
          while (!signal?.aborted) {
            const next = queue.shift();
            if (next !== undefined) {
              yield next;
              continue;
            }
            await new Promise<void>((resolve) => {
              wake = resolve;
              signal?.addEventListener("abort", () => resolve(), { once: true });
            });
          }
        } finally {
          listeners.delete(listener);
        }
      },
    };
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

async function start(files: Record<string, string>, host = new FakeHost(), write: string[] = [], fallbackMs = 60_000) {
  const plugin = createPlugin(harness, { environment: () => fakeEnvironment(files), write: (line) => write.push(line), fallbackMs });
  const cleanup = await plugin.setup(host.ctx);
  return { host, cleanup, write };
}

describe("v2 setup", () => {
  test("project root is the resolved project directory, else the location directory", () => {
    expect(v2ProjectRoot({ location: { directory: "/repo/sub", project: { directory: "/repo" } } } as V2Context)).toBe("/repo");
    expect(v2ProjectRoot({ location: { directory: "/tmp/x" } } as V2Context)).toBe("/tmp/x");
  });

  test("the agent files win until the late transform registers on plugin.updated, then the settings win", async () => {
    const { host } = await start({ [PROJECT]: '{ "profile": "anthropic", "review": "always", "agents": { "scout": { "steps": 9 } } }' });
    host.loader();
    expect(host.build().agents.get("reviewer")!.model!.providerID).toBe("github-copilot");

    host.emit("plugin.updated");
    await settle();
    const state = host.build();
    expect(state.agents.get("reviewer")!.model).toEqual({ id: "claude-opus-5-5", providerID: "anthropic", variant: "high" });
    expect(state.agents.get("scout")!.steps).toBe(9);
    expect(state.agents.get("lead")!.system).toContain("Review policy: always");
    expect(state.default).toBe("lead");
  });

  test("a later activation that reloads the loader is followed by a fresh registration at the end", async () => {
    const { host } = await start({ [GLOBAL]: '{ "profile": "inherit" }' });
    host.loader();
    host.emit("plugin.updated");
    await settle();
    expect(host.transforms).toHaveLength(3);
    expect("model" in host.build().agents.get("lead")!).toBe(false);

    // Re-activation: the loader is unloaded and registered again behind the plugin's transform.
    host.transforms.splice(1, 1);
    host.loader();
    expect(host.build().agents.get("lead")!.model).toBeDefined();
    host.emit("plugin.updated");
    await settle();
    expect(host.transforms).toHaveLength(3);
    expect("model" in host.build().agents.get("lead")!).toBe(false);
  });

  test("other events do not register anything", async () => {
    const { host } = await start({});
    host.emit("agent.updated");
    host.emit("session.created");
    await settle();
    expect(host.transforms).toHaveLength(1);
  });

  test("registers after the fallback delay when no plugin.updated arrives", async () => {
    const host = new FakeHost();
    await start({ [GLOBAL]: '{ "review": "never" }' }, host, [], 20);
    host.loader();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(host.build().agents.get("lead")!.system).toContain("Review policy: never");
  });

  test("a default_agent from config, applied by opencode's later loader, wins over lead", async () => {
    const { host } = await start({});
    host.loader("plan");
    host.emit("plugin.updated");
    await settle();
    expect(host.build().default).toBe("plan");
  });

  test("default_agent false leaves opencode's default alone", async () => {
    const { host } = await start({ [GLOBAL]: '{ "default_agent": false }' });
    host.loader();
    host.emit("plugin.updated");
    await settle();
    expect(host.build().default).toBeUndefined();
  });

  test("an invalid file is written to standard error and the defaults stay", async () => {
    const write: string[] = [];
    const { host } = await start({ [GLOBAL]: '{ "profile": "anthropic", "agents": { "scout": { "steps": "nine" } } }' }, new FakeHost(), write);
    host.loader();
    host.emit("plugin.updated");
    await settle();
    expect(write).toEqual([`ecmwf-multi-agents: ignoring ${GLOBAL}: "agents.scout.steps" must be a whole number of at least 1, not "nine"`]);
    const state = host.build();
    expect(state.agents.get("reviewer")!.model!.providerID).toBe("github-copilot");
    expect(state.agents.get("scout")!.steps).toBe(15);
    expect(state.agents.get("lead")!.system).toBe(LEAD_PROMPT);
  });

  test("a problem found by the transform is reported once, not on every rebuild", async () => {
    const write: string[] = [];
    const { host } = await start({ [GLOBAL]: '{ "review": "never" }' }, new FakeHost(), write);
    host.transforms.push((editor) => editor.update("lead", (agent) => (agent.system = "Custom lead.")));
    host.emit("plugin.updated");
    await settle();
    host.build();
    host.build();
    expect(write).toEqual(['ecmwf-multi-agents: the prompt of lead has no "Review policy:" line, so the review policy stays as the prompt says']);
  });

  test("fail safe: a throwing editor never escapes the transform", async () => {
    const write: string[] = [];
    const { host } = await start({}, new FakeHost(), write);
    host.transforms.push((editor) => {
      editor.get = () => {
        throw new Error("boom");
      };
    });
    host.emit("plugin.updated");
    await settle();
    expect(() => host.build()).not.toThrow();
    expect(write).toEqual(["ecmwf-multi-agents: internal error in the agent transform, settings left unchanged: boom"]);
  });

  test("fail safe: setup never throws, even when opencode's API does", async () => {
    const write: string[] = [];
    const plugin = createPlugin(harness, { environment: () => fakeEnvironment({}), write: (line) => write.push(line) });
    const ctx = {
      agent: {
        transform: async () => {
          throw new Error("no agents here");
        },
      },
    } as unknown as V2Context;
    expect(await plugin.setup(ctx)).toBeUndefined();
    expect(write[0]).toContain("internal error in setup");
  });

  test("cleanup stops listening for activations", async () => {
    const { host, cleanup } = await start({});
    await settle();
    expect(host.subscriptions).toBe(1);
    await cleanup!();
    host.loader();
    host.emit("plugin.updated");
    await settle();
    expect(host.transforms).toHaveLength(2);
  });
});
