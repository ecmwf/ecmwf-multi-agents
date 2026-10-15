// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { WAKE_TEXT } from "./answer-first.ts";
import { createPlugin } from "./plugin.ts";
import { LEAD_PROMPT, embeddedFixture, fakeEnvironment } from "./testing.ts";
import type { V2AgentEditor, V2AgentInfo, V2Context, V2ContextEvent, V2Event, V2ModelMessage, V2ToolCall, V2ToolInfo } from "./types.ts";
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
    session: {
      get: async ({ sessionID }) => (this.sessions[sessionID] === undefined ? undefined : { id: sessionID, ...this.sessions[sessionID] }),
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
    };
    for (const transform of this.transforms) transform(editor);
    return state;
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
