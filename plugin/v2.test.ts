// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { INLINE_WAKE_TEXT, WAKE_TEXT } from "./answer-first.ts";
import { INLINE_MARK, reviewerOffText } from "./inline.ts";
import { STEP_LIMIT_NOTICE } from "./step-limit.ts";
import { createPlugin } from "./plugin.ts";
import { HELPER_OFF, LEAD_PROMPT, TESTER_ROUTING, embeddedFixture, fakeEnvironment } from "./testing.ts";
import type { V2AgentEditor, V2AgentInfo, V2CommandDefinition, V2CommandEditor, V2Context, V2ContextEvent, V2Event, V2ModelMessage, V2ToolCall, V2ToolInfo } from "./types.ts";
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
  private listeners = new Set<(event: V2Event) => void>();
  subscriptions = 0;
  /** Tools added through the tool transform, and the execute.before hooks. */
  tools = new Map<string, V2ToolInfo>();
  toolHooks: Array<(call: V2ToolCall) => Promise<void> | void> = [];
  /** The `context` session hooks, which see each model request before it is sent. */
  contextHooks: Array<(event: V2ContextEvent) => Promise<void> | void> = [];
  /** Messages the plugin asked opencode to write as its own. */
  synthetics: Array<{ sessionID: string; text: string; description?: string; delivery?: string }> = [];
  prompts: Array<{ sessionID: string; text: string; delivery?: string }> = [];
  interrupts: string[] = [];
  sessions: Record<string, { parentID?: string; agent?: string }> = {};
  /** Command transforms in registration order, as opencode keeps them (core/src/command.ts). */
  commandTransforms: Array<(editor: V2CommandEditor) => void> = [];
  switches: string[] = [];
  /** How many times an agent transform was registered. */
  registrations = 0;
  /** What opencode lists as available, when `serve` is called: provider ids, and optionally models. */
  providers: string[] = [];
  models: Array<{ id: string; providerID: string }> | undefined;
  providerCalls = 0;
  modelCalls = 0;

  /** Give the plugin context `provider.list`, and `model.list` when `models` is set: only entries, as 2.2.6 lists them. */
  serve(): void {
    this.ctx.provider = {
      list: async () => {
        this.providerCalls++;
        return { location: {}, data: this.providers.map((id) => ({ id, activation: "auto" })) };
      },
    };
    if (this.models !== undefined) {
      this.ctx.model = {
        list: async () => {
          this.modelCalls++;
          return { location: {}, data: this.models!.map((model) => ({ ...model, enabled: true })) };
        },
      };
    }
  }

  readonly ctx: V2Context = {
    location: { directory: "/repo/sub", project: { directory: "/repo" } },
    agent: {
      transform: async (callback) => {
        const entry = (editor: V2AgentEditor) => callback(editor);
        this.registrations++;
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
    tool: {
      transform: async (callback) => {
        callback({ add: (tool) => this.tools.set(tool.name, tool), remove: (id) => void this.tools.delete(id) });
        return { dispose: async () => {} };
      },
      hook: async (_name, callback) => {
        this.toolHooks.push(callback);
        return { dispose: async () => {} };
      },
    },
    command: {
      transform: async (callback) => {
        const entry = (editor: V2CommandEditor) => callback(editor);
        this.commandTransforms.push(entry);
        return {
          dispose: async () => {
            this.commandTransforms = this.commandTransforms.filter((item) => item !== entry);
          },
        };
      },
    },
    session: {
      get: async ({ sessionID }) => (this.sessions[sessionID] === undefined ? undefined : { id: sessionID, ...this.sessions[sessionID] }),
      switchAgent: async ({ sessionID, agent }) => {
        this.switches.push(agent);
        this.sessions[sessionID] = { ...this.sessions[sessionID], agent };
      },
      wait: async () => {},
      prompt: async (input) => {
        this.prompts.push(input);
        return {};
      },
      interrupt: async ({ sessionID }) => {
        this.interrupts.push(sessionID);
        return {};
      },
      synthetic: async (input) => {
        this.synthetics.push(input);
        return {};
      },
      hook: async (_name, callback) => {
        this.contextHooks.push(callback);
        return { dispose: async () => {} };
      },
    },
  };

  /** Run a tool as opencode would: the hooks first, then the tool. */
  async call(name: string, input: Record<string, unknown>, context: { sessionID: string; agent: string }): Promise<string> {
    for (const hook of this.toolHooks) await hook({ tool: name, input, ...context });
    const tool = this.tools.get(name);
    if (tool === undefined) throw new Error(`no tool ${name}`);
    return (await tool.execute(input, context)).content;
  }

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
      remove: (id) => void state.agents.delete(id),
    };
    for (const transform of this.transforms) transform(editor);
    return state;
  }

  /** The commands after every transform has run: a later `add` of a name replaces an earlier one. */
  commands(): Map<string, V2CommandDefinition> {
    const commands = new Map<string, V2CommandDefinition>();
    for (const transform of this.commandTransforms) transform({ add: (definition) => void commands.set(definition.name, definition) });
    return commands;
  }

  emit(type: string, data?: Record<string, unknown>): void {
    for (const listener of this.listeners) listener({ id: "evt", type, data: data ?? {} });
  }

  private subscribe(signal: AbortSignal | undefined): AsyncIterable<V2Event> {
    const queue: V2Event[] = [];
    let wake: (() => void) | undefined;
    const listener = (event: V2Event) => {
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
    const { host } = await start({ [PROJECT]: '{ "profile": "anthropic", "review": "always", "max_helper_slots": 8, "agents": { "scout": { "steps": 9 } } }' });
    host.loader();
    expect(host.build().agents.get("reviewer")!.model!.providerID).toBe("github-copilot");

    host.emit("plugin.updated");
    await settle();
    const state = host.build();
    expect(state.agents.get("reviewer")!.model).toEqual({ id: "claude-opus-5-5", providerID: "anthropic", variant: "high" });
    expect(state.agents.get("scout")!.steps).toBe(9);
    expect(state.agents.get("lead")!.system).toContain("Review policy: always");
    expect(state.agents.get("lead")!.system).toContain("Run at most 8 helpers at once.");
    expect(state.default).toBe("lead");
  });

  test("settings switch helpers: an optional one arrives, a default one goes, and lead's list follows", async () => {
    const { host, write } = await start({ [GLOBAL]: '{ "agents": { "tester": { "enabled": true } } }', [PROJECT]: '{ "agents": { "scout": { "enabled": false } } }' });
    host.loader();
    // Before the late transform: the files' scout is there, and so is the registered tester.
    expect(host.build().agents.has("scout")).toBe(true);
    expect(host.build().agents.get("tester")).toMatchObject({ mode: "subagent", system: "You are tester." });

    host.emit("plugin.updated");
    await settle();
    const state = host.build();
    expect(state.agents.has("scout")).toBe(false);
    expect(state.agents.has("builder")).toBe(true);
    expect(state.agents.get("tester")!.model).toEqual({ id: "gpt-6.1-sol", providerID: "github-copilot", variant: "high" });
    const lead = state.agents.get("lead")!.system!;
    expect(lead).not.toContain("- scout:");
    expect(lead).toContain(`- reviewer: checks work.\n- tester: ${TESTER_ROUTING}\n- ${HELPER_OFF}\n`);
    expect(write).toEqual([]);
  });

  test("a session start adds the work folder to git's exclude file once; a helper's session does not", async () => {
    const files: Record<string, string> = { "/repo/.git/HEAD": "ref: refs/heads/main\n", "/repo/.git/info/exclude": "# git ls-files --others --exclude-from=.git/info/exclude\n" };
    const { host, write } = await start(files);
    host.emit("session.created", { sessionID: "child", parentID: "root", location: { directory: "/repo/sub" } });
    await settle();
    expect(files["/repo/.git/info/exclude"]).toBe("# git ls-files --others --exclude-from=.git/info/exclude\n");
    host.emit("session.created", { sessionID: "root", location: { directory: "/repo/sub" } });
    host.emit("session.created", { sessionID: "again", location: { directory: "/repo/sub" } });
    await settle();
    expect(files["/repo/.git/info/exclude"]).toBe("# git ls-files --others --exclude-from=.git/info/exclude\n.ecmwf-multi-agents/\n");
    expect(write).toEqual([]);
  });

  test("a work folder the plugin cannot exclude is reported once, and nothing throws", async () => {
    const files: Record<string, string> = { "/repo/.git/HEAD": "ref: refs/heads/main\n" };
    const write: string[] = [];
    const host = new FakeHost();
    const environment = () => ({
      ...fakeEnvironment(files),
      appendFile: () => {
        throw new Error("EACCES: permission denied");
      },
    });
    await createPlugin(harness, { environment, write: (line) => write.push(line), fallbackMs: 60_000 }).setup(host.ctx);
    for (const sessionID of ["one", "two"]) host.emit("session.created", { sessionID, location: { directory: "/repo" } });
    await settle();
    expect(write).toEqual([
      "ecmwf-multi-agents: could not add .ecmwf-multi-agents/ to /repo/.git/info/exclude, so git may list the harness's work files: EACCES: permission denied",
    ]);
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

  test("each agent's own permission rules follow the config's, as with agent files, and the probe never shows", async () => {
    const { host } = await start({});
    const config = [{ action: "shell", resource: "*", effect: "allow" }];
    host.transforms.push((editor) => {
      for (const agent of editor.list()) (agent.permissions ??= []).push(...config);
    });
    const own = harness.agents.find((agent) => agent.id === "scout")!.permissions!;
    expect(host.build().agents.get("scout")!.permissions).toEqual([...own, ...config]);

    host.emit("plugin.updated");
    await settle();
    const state = host.build();
    expect(state.agents.get("scout")!.permissions).toEqual([...config, ...own]);
    expect([...state.agents.keys()].filter((id) => id.endsWith("-rule-probe"))).toEqual([]);
  });

  test("the site file named in the plugin's site option applies first; the user's and the project's override it", async () => {
    const site = "/central/ecmwf-multi-agents.jsonc";
    const host = new FakeHost();
    (host.ctx as { options?: Record<string, unknown> }).options = { site };
    await start({ [site]: '{ "review": "never", "agents": { "scout": { "steps": 4 }, "reviewer": { "steps": 5 } } }', [GLOBAL]: '{ "agents": { "scout": { "steps": 6 } } }' }, host);
    host.loader();
    host.emit("plugin.updated");
    await settle();
    const state = host.build();
    expect(state.agents.get("lead")!.system).toContain("Review policy: never");
    expect(state.agents.get("scout")!.steps).toBe(6);
    expect(state.agents.get("reviewer")!.steps).toBe(5);
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
    expect(write).toEqual([
      'ecmwf-multi-agents: the prompt of lead has no "Review policy:" line, so the review policy stays as the prompt says',
      'ecmwf-multi-agents: the prompt of lead has no "Run at most ... helpers at once." instruction; max_helper_slots was not applied',
    ]);
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
    expect(write).toEqual([
      "ecmwf-multi-agents: internal error in ordering the agents' rules, settings left unchanged: boom",
      "ecmwf-multi-agents: internal error in the agent transform, settings left unchanged: boom",
    ]);
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
    expect(await plugin.setup(ctx)).toBeDefined();
    expect(write[0]).toContain("internal error in registering the agents");
    expect(await plugin.setup(null as unknown as V2Context)).toBeUndefined();
    expect(write.at(-1)).toContain("internal error in setup");
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

describe("v2 fallback models", () => {
  const SCOUT = { model: "openai/gpt-x", effort: "high", fallback: ["anthropic/claude-sonnet-5-5", { model: "github-copilot/sonnet", effort: "low" }] };
  const settingsFile = (agents: Record<string, unknown> = { scout: SCOUT }) => ({ [GLOBAL]: JSON.stringify({ profile: "anthropic", agents }) });
  const PRIMARY = { id: "gpt-x", providerID: "openai", variant: "high" };
  const FALLBACK = { id: "claude-sonnet-5-5", providerID: "anthropic" };
  const FALLBACK_NOTE = "ecmwf-multi-agents: scout runs on anthropic/claude-sonnet-5-5, its fallback number 1: openai/gpt-x skipped: provider openai is not available";

  async function run(providers: string[] | undefined, files = settingsFile(), models?: FakeHost["models"]) {
    const host = new FakeHost();
    if (providers !== undefined) {
      host.providers = providers;
      host.models = models;
      host.serve();
    }
    const { write } = await start(files, host);
    host.loader();
    return { host, write };
  }
  const scout = (host: FakeHost) => host.build().agents.get("scout")!.model;

  test("the primary is listed: it stays, and nothing is said", async () => {
    const { host, write } = await run(["openai", "anthropic"]);
    host.emit("plugin.updated");
    await settle();
    expect(scout(host)).toEqual(PRIMARY);
    expect(write).toEqual([]);
  });

  test("the primary's provider is not listed: the first fallback runs, with its own effort, and is announced once", async () => {
    const { host, write } = await run(["anthropic"]);
    host.emit("plugin.updated");
    await settle();
    expect(scout(host)).toEqual(FALLBACK);
    expect(write).toEqual([FALLBACK_NOTE]);
    host.build();
    host.build();
    expect(write).toEqual([FALLBACK_NOTE]);

    // A fallback with an effort carries it.
    const second = await run(["github-copilot"], settingsFile({ scout: { ...SCOUT, fallback: [{ model: "github-copilot/sonnet", effort: "low" }] } }));
    second.host.emit("plugin.updated");
    await settle();
    expect(scout(second.host)).toEqual({ id: "sonnet", providerID: "github-copilot", variant: "low" });
  });

  test("none usable: the primary stays and one problem is reported, however often providers change", async () => {
    const { host, write } = await run(["elsewhere"]);
    host.emit("plugin.updated");
    await settle();
    expect(scout(host)).toEqual(PRIMARY);
    const mine = () => write.filter((line) => line.includes(": scout: "));
    expect(mine()).toEqual([
      "ecmwf-multi-agents: scout: none of its model and 2 fallbacks is usable, so openai/gpt-x stays: openai/gpt-x skipped: provider openai is not available; " +
        "anthropic/claude-sonnet-5-5 skipped: provider anthropic is not available; github-copilot/sonnet skipped: provider github-copilot is not available",
    ]);
    host.emit("provider.updated");
    host.emit("provider.updated");
    await settle();
    expect(mine()).toHaveLength(1);
  });

  test("without provider.list, or with one that fails, the primary applies and nothing is said", async () => {
    const absent = await run(undefined);
    absent.host.emit("plugin.updated");
    await settle();
    expect(scout(absent.host)).toEqual(PRIMARY);
    expect(absent.write).toEqual([]);

    const failing = await run(undefined);
    failing.host.ctx.provider = { list: async () => Promise.reject(new Error("unavailable")) };
    failing.host.emit("provider.updated");
    failing.host.emit("plugin.updated");
    await settle();
    expect(scout(failing.host)).toEqual(PRIMARY);
    expect(failing.write).toEqual([]);
  });

  test("no fallback configured: an unavailable primary is kept, and nothing is said or re-registered", async () => {
    for (const agents of [{ scout: { model: "openai/gpt-x", effort: "high" } }, { scout: { model: "openai/gpt-x", effort: "high", fallback: [] } }]) {
      const { host, write } = await run(["elsewhere"], settingsFile(agents));
      host.emit("plugin.updated");
      await settle();
      const registrations = host.registrations;
      host.emit("provider.updated");
      host.emit("model.updated");
      await settle();
      expect(scout(host)).toEqual(PRIMARY);
      expect(host.registrations).toBe(registrations);
      expect(write).toEqual([]);
    }
  });

  test("a later failing provider.list restores the primary once", async () => {
    const { host, write } = await run(["anthropic"]);
    host.emit("plugin.updated");
    await settle();
    expect(scout(host)).toEqual(FALLBACK);
    const registrations = host.registrations;

    host.ctx.provider = { list: async () => Promise.reject(new Error("unavailable")) };
    host.emit("provider.updated");
    host.emit("provider.updated");
    await settle();
    expect(scout(host)).toEqual(PRIMARY);
    expect(host.registrations).toBe(registrations + 1);
    expect(write).toEqual([FALLBACK_NOTE]);
  });

  test("availability is read at the first event, once: not at setup, and not again on plugin.updated", async () => {
    const { host, write } = await run(["anthropic"]);
    await settle();
    expect(host.providerCalls).toBe(0);
    host.emit("provider.updated");
    await settle();
    expect(host.providerCalls).toBe(1);
    host.emit("plugin.updated");
    await settle();
    expect(host.providerCalls).toBe(1);
    // The registration after the provider event already used the fallback.
    expect(scout(host)).toEqual(FALLBACK);
    expect(host.registrations).toBe(2);
    expect(write).toEqual([FALLBACK_NOTE]);
  });

  test("the first read at plugin.updated comes before the registration, so the agents never show an unusable model", async () => {
    const { host } = await run(["anthropic"]);
    host.emit("plugin.updated");
    await settle();
    expect(host.providerCalls).toBe(1);
    expect(host.registrations).toBe(2);
    expect(scout(host)).toEqual(FALLBACK);
  });

  test("a provider.updated that changes the choice re-applies it; a repeat does not", async () => {
    const { host, write } = await run(["anthropic"]);
    host.emit("plugin.updated");
    await settle();
    expect(scout(host)).toEqual(FALLBACK);
    const registrations = host.registrations;

    host.emit("provider.updated");
    host.emit("provider.updated");
    await settle();
    expect(host.registrations).toBe(registrations);
    expect(write).toEqual([FALLBACK_NOTE]);

    host.providers = ["openai", "anthropic"];
    host.emit("provider.updated");
    host.emit("provider.updated");
    await settle();
    expect(host.registrations).toBe(registrations + 1);
    expect(scout(host)).toEqual(PRIMARY);
    expect(write).toEqual([FALLBACK_NOTE]);

    host.providers = ["anthropic"];
    host.emit("provider.updated");
    await settle();
    expect(host.registrations).toBe(registrations + 2);
    expect(scout(host)).toEqual(FALLBACK);
  });

  test("a model list decides on models: a missing model falls back, and model.updated recomputes", async () => {
    const all = [{ id: "claude-sonnet-5-5", providerID: "anthropic" }];
    const { host } = await run(["openai", "anthropic"], settingsFile(), all);
    host.emit("plugin.updated");
    await settle();
    expect(scout(host)).toEqual(FALLBACK);
    expect(host.modelCalls).toBe(1);

    host.models!.push({ id: "gpt-x", providerID: "openai" });
    host.emit("model.updated");
    await settle();
    expect(scout(host)).toEqual(PRIMARY);
  });

  test("activation while an event's read is still going waits for it, so the agents never show an unusable model", async () => {
    const { host } = await run(["anthropic"]);
    const list = host.ctx.provider!.list!;
    let release = () => {};
    host.ctx.provider = { list: () => new Promise<void>((resolve) => (release = resolve)).then(() => list()) };
    const before = host.registrations;
    host.emit("provider.updated");
    await settle();
    host.emit("plugin.updated");
    await settle();
    expect(host.registrations).toBe(before);
    release();
    await settle();
    expect(scout(host)).toEqual(FALLBACK);
    expect(host.registrations).toBe(before + 1);
  });

  test("registering again runs the old and the new transform in one rebuild, and lead's rules are not doubled", async () => {
    const { host } = await run(["anthropic"]);
    host.emit("plugin.updated");
    await settle();
    const settled = host.build().agents.get("lead")!.system;
    const transform = host.ctx.agent.transform;
    const during: unknown[] = [];
    host.ctx.agent.transform = async (callback) => {
      const registration = await transform(callback);
      during.push(host.build().agents.get("lead")!.system);
      return registration;
    };
    host.providers = ["openai", "anthropic"];
    host.emit("provider.updated");
    await settle();
    expect(during).toEqual([settled]);
    expect(host.build().agents.get("lead")!.system).toBe(settled);
  });

  test("a helper command run inline uses the chosen fallback when opencode does not name the agent's model", async () => {
    const { host } = await run(["anthropic"]);
    const switched: unknown[] = [];
    host.ctx.session!.switchModel = async ({ model }) => void switched.push(model);
    host.sessions.root = { agent: "lead" };
    host.emit("plugin.updated");
    await settle();
    await host.commands().get("progress")!.execute({ sessionID: "root", prompt: { text: "export" } });
    await settle();
    expect(switched[0]).toEqual(FALLBACK);
  });

  test("a failing model list leaves the choice to the providers", async () => {
    const { host } = await run(["openai", "anthropic"]);
    host.ctx.model = { list: async () => Promise.reject(new Error("unavailable")) };
    host.emit("plugin.updated");
    await settle();
    expect(scout(host)).toEqual(PRIMARY);
  });

  describe("the doctor check", () => {
    const LEAD = { lead: { model: "openai/gpt-x", fallback: ["anthropic/claude-opus-5-5"] } };

    async function doctorRun(providers: string[]) {
      const host = new FakeHost();
      host.providers = providers;
      host.serve();
      let handlers: Record<string, (input: unknown) => Promise<unknown>> = {};
      host.ctx.rpc = {
        register: async (_definition, given) => {
          handlers = given;
          return { dispose: async () => {}, events: { emit: async () => {} } };
        },
      };
      host.ctx.agent.list = async () => [...host.build().agents.values()];
      await start(settingsFile(LEAD), host);
      const doctor = async () => (await handlers.doctor!({})) as { leadChanged: string[]; leadModel: string | null; leadDefinition: string };
      return { host, doctor };
    }

    test("a lead on its fallback is not reported as changed, and the model shown is the fallback", async () => {
      const { host, doctor } = await doctorRun(["anthropic"]);
      // Asked before any event: the doctor makes the first read itself.
      expect(await doctor()).toMatchObject({ leadChanged: [], leadDefinition: "harness", leadModel: "anthropic/claude-opus-5-5" });
      host.emit("plugin.updated");
      await settle();
      expect(await doctor()).toMatchObject({ leadChanged: [], leadModel: "anthropic/claude-opus-5-5" });
    });

    test("also after a provider change, in both directions", async () => {
      const { host, doctor } = await doctorRun(["anthropic"]);
      host.emit("plugin.updated");
      await settle();
      expect(await doctor()).toMatchObject({ leadChanged: [], leadModel: "anthropic/claude-opus-5-5" });

      host.providers = ["openai"];
      host.emit("provider.updated");
      await settle();
      expect(await doctor()).toMatchObject({ leadChanged: [], leadModel: "openai/gpt-x" });

      host.providers = ["anthropic"];
      host.emit("provider.updated");
      await settle();
      expect(await doctor()).toMatchObject({ leadChanged: [], leadModel: "anthropic/claude-opus-5-5" });
    });

    test("after a failing provider.list the lead is back on its primary, and the doctor agrees", async () => {
      const { host, doctor } = await doctorRun(["anthropic"]);
      host.emit("plugin.updated");
      await settle();
      expect(await doctor()).toMatchObject({ leadChanged: [], leadModel: "anthropic/claude-opus-5-5" });

      host.ctx.provider = { list: async () => Promise.reject(new Error("unavailable")) };
      host.emit("provider.updated");
      await settle();
      expect(await doctor()).toMatchObject({ leadChanged: [], leadModel: "openai/gpt-x" });
    });
  });
});

describe("v2 helper tools and guard", () => {
  test("the three tools are added as direct tools, and a helper's call to them is refused", async () => {
    const { host } = await start({});
    expect([...host.tools.keys()]).toEqual(["helpers_status", "helpers_steer", "helpers_cancel"]);
    for (const tool of host.tools.values()) {
      expect(tool.options).toEqual({ codemode: false });
      expect(tool.input.type).toBe("object");
      expect(tool.input.additionalProperties).toBe(false);
    }
    expect(host.tools.get("helpers_steer")!.input.required).toEqual(["id", "text"]);
    await expect(host.call("helpers_status", {}, { sessionID: "c1", agent: "scout" })).rejects.toThrow("helpers may not use helpers_status");
    expect(await host.call("helpers_status", {}, { sessionID: "root", agent: "lead" })).toBe("No helpers in this session.");
  });

  test("status, steer and cancel follow the children the event stream announced", async () => {
    const { host } = await start({});
    await settle();
    host.emit("session.created", { sessionID: "c1", parentID: "root", agent: "scout", title: "find X" });
    host.emit("session.execution.started", { sessionID: "c1" });
    host.emit("session.created", { sessionID: "c2", parentID: "root", agent: "builder", title: "fix Y" });
    host.emit("session.execution.started", { sessionID: "c2" });
    host.emit("session.execution.succeeded", { sessionID: "c2" });
    await settle();
    await host.call("helpers_status", {}, { sessionID: "c1", agent: "scout" }).catch(() => undefined);
    const status = await host.call("helpers_status", {}, { sessionID: "root", agent: "lead" });
    expect(status).toContain("2 helpers in this session");
    expect(status).toContain("c2, builder, done, 0 steps");
    expect(status).toContain("c1, scout, running, 0 steps");

    expect(await host.call("helpers_steer", { id: "c1", text: "narrow it to src/" }, { sessionID: "root", agent: "lead" })).toContain("Sent to scout c1");
    expect(host.prompts).toEqual([{ sessionID: "c1", text: "lead amends your brief:\nnarrow it to src/", delivery: "steer" }]);
    expect(await host.call("helpers_steer", { id: "c2", text: "more" }, { sessionID: "root", agent: "lead" })).toContain('sessionID: "c2"');
    expect(await host.call("helpers_steer", { id: "c1", text: "x" }, { sessionID: "elsewhere", agent: "lead" })).toBe("c1 is not a helper of this session.");

    expect(await host.call("helpers_cancel", { id: "all" }, { sessionID: "root", agent: "lead" })).toStartWith("Stopped scout c1.");
    expect(host.interrupts).toEqual(["c1"]);
    expect(await host.call("helpers_status", {}, { sessionID: "root", agent: "lead" })).toContain("c1, scout, stopped");
    // Before the stream's interrupted event arrives, a second cancel or a steer sees the stop too.
    expect(await host.call("helpers_cancel", { id: "c1" }, { sessionID: "root", agent: "lead" })).toBe("scout c1 is not running.");
    expect(await host.call("helpers_steer", { id: "c1", text: "x" }, { sessionID: "root", agent: "lead" })).toContain("not running");
    expect(host.interrupts).toEqual(["c1"]);
  });

  test("a session the stream did not announce is looked up through the session API; its state is unknown", async () => {
    const { host } = await start({});
    host.sessions.late = { parentID: "root", agent: "scout" };
    expect(await host.call("helpers_steer", { id: "late", text: "x" }, { sessionID: "root", agent: "lead" })).toContain("started before this plugin could watch it");
    expect(host.prompts).toEqual([]);
    expect(await host.call("helpers_cancel", { id: "late" }, { sessionID: "root", agent: "lead" })).toBe("scout late is not running.");
    expect(await host.call("helpers_cancel", { id: "ghost" }, { sessionID: "root", agent: "lead" })).toContain('No session "ghost"');
  });

  test("cancel all stops the harness's running helpers only", async () => {
    const { host } = await start({});
    await settle();
    host.emit("session.created", { sessionID: "c1", parentID: "root", agent: "scout" });
    host.emit("session.execution.started", { sessionID: "c1" });
    host.emit("session.created", { sessionID: "g1", parentID: "root", agent: "general" });
    host.emit("session.execution.started", { sessionID: "g1" });
    await settle();
    expect(await host.call("helpers_status", {}, { sessionID: "root", agent: "lead" })).not.toContain("g1");
    expect(await host.call("helpers_cancel", { id: "all" }, { sessionID: "root", agent: "lead" })).toStartWith("Stopped scout c1.");
    expect(host.interrupts).toEqual(["c1"]);
    expect(await host.call("helpers_cancel", { id: "g1" }, { sessionID: "root", agent: "lead" })).toBe("g1 is not a harness helper (its agent is general).");
  });

  test("a session seen only through execution events is completed from the session API before the ownership check", async () => {
    const { host } = await start({});
    await settle();
    host.emit("session.execution.started", { sessionID: "orphan" });
    await settle();
    host.sessions.orphan = { parentID: "root", agent: "builder" };
    expect(await host.call("helpers_steer", { id: "orphan", text: "stop" }, { sessionID: "root", agent: "lead" })).toContain("Sent to builder orphan");
    expect(host.prompts.at(-1)).toEqual({ sessionID: "orphan", text: "lead amends your brief:\nstop", delivery: "steer" });
    expect(await host.call("helpers_status", {}, { sessionID: "root", agent: "lead" })).toContain("orphan, builder, running");
  });

  test("tool calls feed the status report's step count and last call", async () => {
    const { host } = await start({});
    await settle();
    host.emit("session.created", { sessionID: "c1", parentID: "root", agent: "scout" });
    host.emit("session.execution.started", { sessionID: "c1" });
    await settle();
    for (const hook of host.toolHooks) await hook({ tool: "grep", sessionID: "c1", agent: "scout", input: { pattern: "foo" } });
    for (const hook of host.toolHooks) await hook({ tool: "read", sessionID: "c1", agent: "scout", input: { filePath: "/a" } });
    expect(await host.call("helpers_status", {}, { sessionID: "root", agent: "lead" })).toContain("c1, scout, running, 2 steps");
    expect(await host.call("helpers_status", {}, { sessionID: "root", agent: "lead" })).toContain("last: read");
  });
});

describe("v2 answer first", () => {
  const user = (text: string): V2ModelMessage => ({ role: "user", content: [{ type: "text", text }] });
  const report = () => user('<subagent sessionID="ses_c" state="completed">\nSTATUS: DONE\n</subagent>');
  const request = (): V2ModelMessage[] => [
    user("What range does the quality check accept?"),
    { role: "assistant", content: [{ type: "tool-call", id: "call_1", name: "read", input: {} }] },
    { role: "tool", content: [{ type: "tool-result", id: "call_1", name: "read", result: { type: "text", value: "MIN = -90" } }] },
    report(),
  ];

  test("lead's request leaves out a report that arrived while lead looked up the answer, and one wake is queued for after the turn", async () => {
    const { host } = await start({});
    expect(host.contextHooks).toHaveLength(1);
    const first = { sessionID: "root", agent: "lead", messages: request() };
    await host.contextHooks[0]!(first);
    expect(first.messages).toHaveLength(3);
    expect(first.messages.some((message) => message.content?.[0]?.text?.startsWith("<subagent "))).toBe(false);
    expect(host.synthetics).toEqual([{ sessionID: "root", text: WAKE_TEXT, description: "Reports held until lead answered", delivery: "queue" }]);
    // The next request of the same reply leaves it out again, without a second wake.
    const second = { sessionID: "root", agent: "lead", messages: request() };
    await host.contextHooks[0]!(second);
    expect(second.messages).toHaveLength(3);
    expect(host.synthetics).toHaveLength(1);
  });

  test("once lead has answered and the wake has come, the report is in view; another agent's request is untouched", async () => {
    const { host } = await start({});
    const woken = { sessionID: "root", agent: "lead", messages: [...request(), { role: "assistant", content: [{ type: "text", text: "From -90 to 60." }] }, user(WAKE_TEXT)] };
    await host.contextHooks[0]!(woken);
    expect(woken.messages).toHaveLength(6);
    const scout = { sessionID: "c1", agent: "scout", messages: request() };
    await host.contextHooks[0]!(scout);
    expect(scout.messages).toHaveLength(4);
    expect(host.synthetics).toEqual([]);
  });

  test("at the step limit, a harness agent's request ends with opencode's notice as a user message; another agent's is untouched", async () => {
    const { host } = await start({});
    const notice = (): V2ModelMessage => ({ role: "assistant", content: [{ type: "text", text: STEP_LIMIT_NOTICE }] });
    for (const agent of ["scout", "tester", "lead"]) {
      const event = { sessionID: `s-${agent}`, agent, messages: [...request().slice(0, 3), notice()] };
      await host.contextHooks[0]!(event);
      expect([agent, event.messages.at(-1)]).toEqual([agent, user(STEP_LIMIT_NOTICE)]);
    }
    const other = { sessionID: "s-build", agent: "build", messages: [...request().slice(0, 3), notice()] };
    await host.contextHooks[0]!(other);
    expect(other.messages.at(-1)).toEqual(notice());
    expect(host.synthetics).toEqual([]);
  });

  test("when no wake can be queued, the report stays in view and the error is reported, never thrown", async () => {
    const write: string[] = [];
    const host = new FakeHost();
    host.ctx.session!.synthetic = async () => {
      throw new Error("inbox closed");
    };
    const { host: started } = await start({}, host, write);
    const event = { sessionID: "root", agent: "lead", messages: request() };
    await started.contextHooks[0]!(event);
    expect(event.messages).toHaveLength(4);
    expect(write.some((line) => line.includes("internal error in the context hook"))).toBe(true);
    delete (host.ctx.session as { synthetic?: unknown }).synthetic;
    const without = { sessionID: "root", agent: "lead", messages: request() };
    await started.contextHooks[0]!(without);
    expect(without.messages).toHaveLength(4);
  });

  test("fail safe: a malformed event is ignored, and an error is reported, never thrown", async () => {
    const write: string[] = [];
    const { host } = await start({}, new FakeHost(), write);
    const hook = host.contextHooks[0]!;
    await hook(undefined as never);
    await hook({ agent: "lead", messages: "none" as never });
    const broken = {
      get role(): string {
        throw new Error("boom");
      },
    };
    await hook({ agent: "lead", messages: [broken] });
    expect(write.some((line) => line.includes("internal error in the context hook"))).toBe(true);
  });

  test("without the session hook (an older opencode 2), setup still completes", async () => {
    const host = new FakeHost();
    delete (host.ctx.session as { hook?: unknown }).hook;
    const { cleanup } = await start({}, host);
    expect(typeof cleanup).toBe("function");
  });
});

describe("v2 inline commands", () => {
  const user = (text: string, metadata?: Record<string, unknown>): V2ModelMessage => ({ role: "user", content: [{ type: "text", text }], ...(metadata ? { metadata } : {}) });
  const report = (id: string): V2ModelMessage => ({ id, ...user(`<subagent sessionID="ses_${id}" state="completed">\nDONE\n</subagent>`) });

  test("review and progress are registered on plugin.updated, over the plugin's own first registration and the command files, and again on each activation", async () => {
    const { host } = await start({});
    // The registration during setup (register.ts): every harness command, the helpers' in a child session.
    expect(host.commandTransforms).toHaveLength(1);
    const early = host.commands();
    expect([...early.keys()]).toEqual(["plan", "review", "progress"]);
    // opencode's loader for command files comes after it.
    const files = (editor: V2CommandEditor) => editor.add({ name: "review", description: "file", execute: async () => {} });
    host.commandTransforms.push(files);
    host.emit("plugin.updated");
    await settle();
    expect(host.commandTransforms).toHaveLength(3);
    const late = host.commands();
    expect(late.get("plan")).toBe(early.get("plan")!);
    for (const name of ["review", "progress"]) {
      expect(late.get(name)).not.toBe(early.get(name)!);
      expect(late.get(name)!.description).not.toBe("file");
    }
    // The late review answers inline: it switches the session to the reviewer, never makes a child.
    host.sessions.root = { agent: "lead" };
    await late.get("review")!.execute({ sessionID: "root", prompt: { text: "x" } });
    await settle();
    expect(host.switches).toEqual(["reviewer", "lead"]);
    // A later activation re-registers the loader behind the plugin; the plugin moves to the end again.
    host.commandTransforms = host.commandTransforms.filter((item) => item !== files);
    host.commandTransforms.push(files);
    host.emit("plugin.updated");
    await settle();
    expect(host.commandTransforms).toHaveLength(3);
    expect(host.commands().get("review")!.description).toBe("Independent review of your changes");
  });

  test("with scout and the reviewer off, /progress runs on lead and /review refuses with a message", async () => {
    const { host } = await start({ [PROJECT]: '{ "agents": { "scout": { "enabled": false }, "reviewer": { "enabled": false } } }' });
    host.sessions.root = { agent: "lead" };
    host.emit("plugin.updated");
    await settle();
    await host.commands().get("progress")!.execute({ sessionID: "root", prompt: { text: "export" } });
    await settle();
    expect(host.switches).toEqual([]);
    expect(host.prompts.at(-1)).toMatchObject({ sessionID: "root", text: "Progress of export" });
    const prompts = host.prompts.length;
    await expect(host.commands().get("review")!.execute({ sessionID: "root", prompt: { text: "main" } })).rejects.toThrow(reviewerOffText(harness));
    await settle();
    expect(host.synthetics).toEqual([]);
    expect(host.prompts).toHaveLength(prompts);
  });

  test("a helper's request goes to the inline run and lead's to answer-first, through the one context hook", async () => {
    const { host } = await start({});
    host.sessions.root = { agent: "lead" };
    host.emit("plugin.updated");
    await settle();
    let release = () => {};
    host.ctx.session!.wait = () => new Promise<void>((resolve) => (release = resolve));
    await host.commands().get("review")!.execute({ sessionID: "root", prompt: { text: "main" } });
    release();
    await settle();
    expect(host.switches).toEqual(["reviewer"]);
    expect(host.prompts.at(-1)).toMatchObject({ sessionID: "root", text: "Review main", metadata: { [INLINE_MARK]: "review" } });

    const reviewer = { sessionID: "root", agent: "reviewer", messages: [user("hello"), user("Review main", { [INLINE_MARK]: "review" }), report("r1")] };
    await host.contextHooks[0]!(reviewer);
    expect(reviewer.messages).toHaveLength(1);
    expect(host.synthetics).toEqual([]);

    release();
    await settle();
    expect(host.switches).toEqual(["reviewer", "lead"]);
    expect(host.synthetics.map((item) => item.text)).toEqual([INLINE_WAKE_TEXT]);
    // lead's turn on the wake: the report is in view, and answer-first queues no second wake.
    const lead = {
      sessionID: "root",
      agent: "lead",
      messages: [user("Review main"), report("r1"), { role: "assistant", content: [{ type: "text", text: "VERDICT: APPROVE" }] }, user(INLINE_WAKE_TEXT)],
    };
    await host.contextHooks[0]!(lead);
    expect(lead.messages).toHaveLength(4);
    expect(host.synthetics).toHaveLength(1);
  });

  test("without the session calls a run needs, the file commands stay", async () => {
    const host = new FakeHost();
    delete (host.ctx.session as { switchAgent?: unknown }).switchAgent;
    await start({}, host);
    host.emit("plugin.updated");
    await settle();
    // Only the registration during setup, which runs the helpers' commands in a child session.
    expect(host.commandTransforms).toHaveLength(1);
  });
});
