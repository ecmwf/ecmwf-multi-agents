// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { createPlugin } from "./plugin.ts";
import { LEAD_PROMPT, embeddedFixture, fakeEnvironment } from "./testing.ts";
import type { Environment, V1Client, V1Config, V1Hooks, V1UserMessage } from "./types.ts";
import { v1ProjectRoot } from "./v1.ts";

const harness = embeddedFixture();
const GLOBAL = "/home/user/.config/opencode/ecmwf-multi-agents.jsonc";
const PROJECT = "/repo/.opencode/ecmwf-multi-agents.jsonc";

interface Recorder {
  logs: Array<{ level: string; message: string }>;
  toasts: string[];
  lookups: string[];
  client: V1Client;
}

function recorder(sessions: Record<string, string> = {}): Recorder {
  const record: Recorder = {
    logs: [],
    toasts: [],
    lookups: [],
    client: {
      app: {
        log: async ({ body }) => {
          record.logs.push({ level: body.level, message: body.message });
          return true;
        },
      },
      tui: {
        showToast: async ({ body }) => {
          record.toasts.push(body.message);
          return true;
        },
      },
      session: {
        get: async ({ path }) => {
          record.lookups.push(path.id);
          return { data: { agent: sessions[path.id] } };
        },
      },
    },
  };
  return record;
}

async function start(files: Record<string, string>, record = recorder(), environment?: () => Environment): Promise<V1Hooks> {
  const plugin = createPlugin(harness, {
    environment: environment ?? (() => fakeEnvironment(files)),
    schedule: (run) => run(),
  });
  return plugin.server({ client: record.client, directory: "/repo/sub", worktree: "/repo" });
}

function config(): V1Config {
  return {
    agent: {
      lead: { mode: "primary", model: "anthropic/claude-opus-5-5", variant: "xhigh", prompt: LEAD_PROMPT },
      scout: { mode: "subagent", model: "anthropic/claude-sonnet-5-5", variant: "medium", steps: 15, prompt: "You are scout." },
      reviewer: { mode: "subagent", model: "github-copilot/gpt-6.1-sol", variant: "medium", steps: 30, prompt: "You are reviewer." },
    },
  };
}

async function shell(hooks: V1Hooks, sessionID: string, command: string): Promise<string | undefined> {
  try {
    await hooks["tool.execute.before"]({ tool: "bash", sessionID, callID: "c1" }, { args: { command, description: "probe" } });
    return undefined;
  } catch (error) {
    return (error as Error).message;
  }
}

describe("v1 server", () => {
  test("the module shape: id, server and setup", () => {
    const plugin = createPlugin(harness);
    expect(plugin.id).toBe("ecmwf-multi-agents");
    expect(typeof plugin.server).toBe("function");
    expect(typeof plugin.setup).toBe("function");
  });

  test("project root is the git worktree, or the directory outside git", () => {
    expect(v1ProjectRoot({ directory: "/repo/sub", worktree: "/repo" })).toBe("/repo");
    expect(v1ProjectRoot({ directory: "/tmp/x", worktree: "/" })).toBe("/tmp/x");
    expect(v1ProjectRoot({})).toBeUndefined();
  });

  test("the config hook applies global and project settings", async () => {
    const hooks = await start({
      [GLOBAL]: '{ "profile": "anthropic", "review": "never" }',
      [PROJECT]: '{ "review": "always", "agents": { "scout": { "steps": 9 } } }',
    });
    const cfg = config();
    await hooks.config(cfg);
    expect(cfg.agent!.reviewer).toMatchObject({ model: "anthropic/claude-opus-5-5", variant: "high" });
    expect(cfg.agent!.scout!.steps).toBe(9);
    expect(cfg.agent!.lead!.prompt).toContain("Review policy: always");
    expect(cfg.default_agent).toBe("lead");
  });

  test("an invalid file is logged and shown as a toast, and the defaults stay", async () => {
    const record = recorder();
    const hooks = await start({ [GLOBAL]: '{ "profile": "anthropic", "review": "sometimes" }' }, record);
    const cfg = config();
    await hooks.config(cfg);
    expect(cfg.agent!.reviewer).toMatchObject({ model: "github-copilot/gpt-6.1-sol", variant: "medium" });
    expect(cfg.agent!.lead!.prompt).toBe(LEAD_PROMPT);
    const message = `ecmwf-multi-agents: ignoring ${GLOBAL}: "review" must be auto, ask, always or never, not "sometimes"`;
    expect(record.logs).toEqual([{ level: "warn", message }]);
    expect(record.toasts).toEqual([message]);
  });

  test("several problems share one delayed toast", async () => {
    const record = recorder();
    const pending: Array<{ run: () => void; ms: number }> = [];
    const plugin = createPlugin(harness, {
      environment: () => fakeEnvironment({ [GLOBAL]: "{ nope", [PROJECT]: '{ "profile": "inherit", "agents": { "scout": { "variant": "high" } } }' }),
      schedule: (run, ms) => pending.push({ run, ms }),
    });
    await plugin.server({ client: record.client, directory: "/repo", worktree: "/repo" });
    expect(record.logs).toHaveLength(2);
    expect(record.toasts).toEqual([]);
    expect(pending.map((item) => item.ms)).toEqual([2000]);
    pending[0]!.run();
    expect(record.toasts).toHaveLength(1);
    expect(record.toasts[0]!.split("\n")).toHaveLength(2);
  });

  test("the guard blocks a helper's denied command and lets others through", async () => {
    const hooks = await start({});
    await hooks["chat.message"]({ sessionID: "child", agent: "builder" }, { message: { agent: "builder" } });
    await hooks["chat.message"]({ sessionID: "root" }, { message: { agent: "lead" } });
    expect(await shell(hooks, "child", "bun test && git push origin main")).toContain('helpers may not run "git push origin main"');
    expect(await shell(hooks, "child", "bun test")).toBeUndefined();
    expect(await shell(hooks, "root", "git push origin main")).toBeUndefined();
  });

  test("the guard ignores other tools and malformed arguments", async () => {
    const hooks = await start({});
    await hooks["chat.message"]({ sessionID: "child", agent: "builder" }, { message: { agent: "builder" } });
    await hooks["tool.execute.before"]({ tool: "read", sessionID: "child" }, { args: { command: "git push" } });
    await hooks["tool.execute.before"]({ tool: "bash", sessionID: "child" }, { args: { command: 42 } });
    await hooks["tool.execute.before"]({ tool: "bash", sessionID: "child" }, {});
  });

  test("chat.params records the agent too, except tool-less built-ins", async () => {
    const record = recorder();
    const hooks = await start({}, record);
    await hooks["chat.params"]({ sessionID: "s", agent: "reviewer" }, {});
    await hooks["chat.params"]({ sessionID: "s", agent: "title" }, {});
    expect(await shell(hooks, "s", "gh pr merge 1")).toContain("helpers may not run");
    expect(record.lookups).toEqual([]);
  });

  test("an agent switch is followed in the user's own session, and pinned back in a helper's child session", async () => {
    const hooks = await start({});
    // The user's session: lead first, a helper answering inline, lead again.
    await hooks["chat.message"]({ sessionID: "own" }, { message: { agent: "lead" } });
    await hooks["chat.message"]({ sessionID: "own" }, { message: { agent: "reviewer" } });
    expect(await shell(hooks, "own", "git push")).toBeDefined();
    await hooks["chat.message"]({ sessionID: "own" }, { message: { agent: "lead" } });
    expect(await shell(hooks, "own", "git push")).toBeUndefined();
    // A child session (announced by session.created): the builder first, then a message that
    // names lead, which is pinned back.
    await hooks.event({ event: { type: "session.created", properties: { info: { id: "child", parentID: "own" } } } });
    await hooks["chat.message"]({ sessionID: "child" }, { message: { agent: "builder" } });
    const pinned = { agent: "lead" };
    await hooks["chat.message"]({ sessionID: "child" }, { message: pinned });
    expect(pinned.agent).toBe("builder");
    expect(await shell(hooks, "child", "git push")).toBeDefined();
  });

  test("an unknown session is looked up once through the client", async () => {
    const record = recorder({ old: "scout" });
    const hooks = await start({}, record);
    expect(await shell(hooks, "old", "rm -rf x")).toContain("scout may not run");
    expect(await shell(hooks, "old", "ls")).toBeUndefined();
    expect(record.lookups).toEqual(["old"]);
    expect(await shell(hooks, "nobody", "git push")).toBeUndefined();
  });

  test("a failing lookup lets the command through and logs nothing alarming", async () => {
    const record = recorder();
    record.client.session = {
      get: async () => {
        throw new Error("server gone");
      },
    };
    const hooks = await start({}, record);
    expect(await shell(hooks, "x", "git push")).toBeUndefined();
    expect(record.logs.map((log) => log.level)).toEqual(["error"]);
  });

  test("fail safe: errors in hooks are logged, never thrown, and leave the config as it was", async () => {
    const record = recorder();
    const hooks = await start({}, record);
    const cfg = config();
    const before = structuredClone(cfg);
    Object.defineProperty(cfg.agent!, "reviewer", {
      get() {
        throw new Error("boom");
      },
    });
    await hooks.config(cfg);
    expect(cfg.agent!.lead).toEqual(before.agent!.lead!);
    expect(cfg.default_agent).toBeUndefined();
    expect(record.logs).toEqual([{ level: "error", message: "ecmwf-multi-agents: internal error in the config hook, settings left unchanged: boom" }]);
    await hooks.config(null as unknown as V1Config);
    await hooks["chat.message"](null as never, null as never);
    await hooks["chat.params"](null as never, null);
    await hooks["tool.execute.before"](null as never, null as never);
  });

  test("fail safe: a broken environment still gives working hooks with the defaults", async () => {
    const record = recorder();
    const hooks = await start({}, record, () => {
      throw new Error("no home");
    });
    const cfg = config();
    await hooks.config(cfg);
    expect(cfg.default_agent).toBe("lead");
    expect(record.logs[0]?.message).toContain("internal error in reading the settings");
  });

  test("works without a client", async () => {
    const plugin = createPlugin(harness, { environment: () => fakeEnvironment({ [GLOBAL]: "{ bad" }), schedule: (run) => run() });
    const hooks = await plugin.server({ directory: "/repo", worktree: "/repo" });
    const cfg = config();
    await hooks.config(cfg);
    expect(cfg.default_agent).toBe("lead");
  });
});

describe("v1 helper requests in the user's session", () => {
  const conversation = (helper: string) => [
    { info: { role: "user", agent: "lead", sessionID: "ses_root" }, parts: [{ type: "text", text: "explain" }] },
    { info: { role: "assistant", agent: "lead", sessionID: "ses_root" }, parts: [{ type: "text", text: "it works like this" }] },
    { info: { role: "user", agent: helper, sessionID: "ses_root" }, parts: [{ type: "text", text: "review" }] },
  ];

  test("a request by a helper of the harness drops the earlier conversation", async () => {
    const hooks = await start({});
    const output = { messages: conversation("reviewer") };
    await hooks["experimental.chat.messages.transform"]({}, output);
    expect(output.messages.map((item) => item.info.agent)).toEqual(["reviewer"]);
  });

  test("a request by lead, or by an agent outside the harness, keeps everything", async () => {
    const hooks = await start({});
    for (const agent of ["lead", "build", "general"]) {
      const output = { messages: conversation(agent) };
      await hooks["experimental.chat.messages.transform"]({}, output);
      expect(output.messages).toHaveLength(3);
    }
  });

  test("compaction's pass through the hook is never trimmed, and the next request is again", async () => {
    const hooks = await start({});
    await hooks["experimental.session.compacting"]({ sessionID: "ses_root" }, { context: [] });
    const compaction = { messages: conversation("reviewer") };
    await hooks["experimental.chat.messages.transform"]({}, compaction);
    expect(compaction.messages).toHaveLength(3);
    const next = { messages: conversation("reviewer") };
    await hooks["experimental.chat.messages.transform"]({}, next);
    expect(next.messages).toHaveLength(1);
  });

  test("fail safe: malformed input is ignored and nothing is thrown", async () => {
    const record = recorder();
    const hooks = await start({}, record);
    await hooks["experimental.chat.messages.transform"](null, null as never);
    await hooks["experimental.chat.messages.transform"]({}, { messages: [null, undefined] as never });
    await hooks["experimental.session.compacting"](null as never, null);
    expect(record.logs.filter((log) => log.level === "error")).toEqual([]);
  });
});

describe("v1 helper tools, guard and pinning", () => {
  interface Fake {
    client: V1Client;
    sessions: Record<string, { agent?: string; parentID?: string; title?: string; created?: number }>;
    busy: Set<string>;
    prompts: Array<{ id: string; agent?: string; text: string }>;
    aborts: string[];
  }

  function fake(): Fake {
    const state: Fake = {
      sessions: {
        root: { agent: "lead" },
        c1: { agent: "scout", parentID: "root", title: "find X", created: 1_000 },
        c2: { agent: "builder", parentID: "root", title: "fix Y", created: 2_000 },
        other: { agent: "scout", parentID: "elsewhere" },
        general: { agent: "general", parentID: "root", title: "not ours", created: 3_000 },
      },
      busy: new Set(["c1", "c2", "general"]),
      prompts: [],
      aborts: [],
      client: {
        session: {
          get: async ({ path }) => ({ data: state.sessions[path.id] === undefined ? null : { id: path.id, ...state.sessions[path.id] } }),
          children: async ({ path }) => ({
            data: Object.entries(state.sessions)
              .filter(([, info]) => info.parentID === path.id)
              .map(([id, info]) => ({ id, agent: info.agent, title: info.title, time: { created: info.created } })),
          }),
          status: async () => ({ data: Object.fromEntries([...state.busy].map((id) => [id, { type: "busy" }])) }),
          promptAsync: async ({ path, body }) => {
            state.prompts.push({ id: path.id, agent: body.agent, text: body.parts[0]!.text });
            return {};
          },
          abort: async ({ path }) => {
            state.busy.delete(path.id);
            state.aborts.push(path.id);
            return {};
          },
        },
      },
    };
    return state;
  }

  async function hooksWith(state: Fake): Promise<V1Hooks> {
    const plugin = createPlugin(harness, { environment: () => fakeEnvironment({}), schedule: (run) => run() });
    return plugin.server({ client: state.client, directory: "/repo", worktree: "/repo" });
  }

  /** opencode announces a session: `session.created` with the parent, if any. */
  const created = (hooks: V1Hooks, id: string, parentID?: string) => hooks.event({ event: { type: "session.created", properties: { info: { id, ...(parentID ? { parentID } : {}) } } } });

  test("the tool hook offers the three tools", async () => {
    const hooks = await hooksWith(fake());
    expect(Object.keys(hooks.tool)).toEqual(["helpers_status", "helpers_steer", "helpers_cancel"]);
    expect(hooks.tool.helpers_steer!.args.id!.type).toBe("string");
  });

  test("helpers_status lists the children of the caller's session with their activity", async () => {
    const state = fake();
    const hooks = await hooksWith(state);
    await hooks["tool.execute.before"]({ tool: "grep", sessionID: "c1" }, { args: { pattern: "foo" } });
    await hooks["tool.execute.before"]({ tool: "bash", sessionID: "c1" }, { args: { command: "git log" } });
    const text = await hooks.tool.helpers_status!.execute({}, { sessionID: "root", agent: "lead" });
    const lines = text.split("\n");
    // The general child is not a harness helper and is left out, as cancel leaves it alone.
    expect(lines[0]).toBe("2 helpers in this session, newest first:");
    expect(lines[1]).toMatch(/^c2, builder, running, 0 steps, \d+[smh].*: fix Y$/);
    expect(lines[2]).toMatch(/^c1, scout, running, 2 steps, .*: find X; last: bash: git log$/);
    expect(text).not.toContain("general");
    expect(await hooks.tool.helpers_status!.execute({}, { sessionID: "lonely", agent: "lead" })).toBe("No helpers in this session.");
  });

  test("helpers_steer sends the amendment to a running child as its own agent", async () => {
    const state = fake();
    const hooks = await hooksWith(state);
    const steer = hooks.tool.helpers_steer!;
    expect(await steer.execute({ id: "c1", text: " skip the tests " }, { sessionID: "root", agent: "lead" })).toContain("Sent to scout c1");
    expect(state.prompts).toEqual([{ id: "c1", agent: "scout", text: "lead amends your brief:\nskip the tests" }]);
    expect(await steer.execute({ id: "other", text: "x" }, { sessionID: "root", agent: "lead" })).toBe("other is not a helper of this session.");
    expect(await steer.execute({ id: "nope", text: "x" }, { sessionID: "root", agent: "lead" })).toContain('No session "nope"');
    state.busy.delete("c1");
    expect(await steer.execute({ id: "c1", text: "x" }, { sessionID: "root", agent: "lead" })).toContain('task_id: "c1"');
    expect(state.prompts).toHaveLength(1);
    await expect(steer.execute({ id: "c1", text: "  " }, { sessionID: "root", agent: "lead" })).rejects.toThrow("text must be a non-empty string");
  });

  test("helpers_cancel aborts one child or all running children and remembers them as stopped", async () => {
    const state = fake();
    const hooks = await hooksWith(state);
    const cancel = hooks.tool.helpers_cancel!;
    expect(await cancel.execute({ id: "c1" }, { sessionID: "root", agent: "lead" })).toStartWith("Stopped scout c1.");
    expect(await cancel.execute({ id: "c1" }, { sessionID: "root", agent: "lead" })).toBe("scout c1 is not running.");
    // "all" stops the harness's helpers only; the general child is not ours to stop.
    expect(await cancel.execute({ id: "all" }, { sessionID: "root", agent: "lead" })).toStartWith("Stopped builder c2.");
    expect(await cancel.execute({ id: "all" }, { sessionID: "root", agent: "lead" })).toBe("No running helper to stop.");
    expect(await cancel.execute({ id: "general" }, { sessionID: "root", agent: "lead" })).toBe("general is not a harness helper (its agent is general).");
    expect(state.aborts).toEqual(["c1", "c2"]);
    const status = await hooks.tool.helpers_status!.execute({}, { sessionID: "root", agent: "lead" });
    expect(status).toContain("c1, scout, stopped");
    expect(status).toContain("c2, builder, stopped");
  });

  test("the guard refuses a helper's call to the tools, looking the agent up when unseen", async () => {
    const state = fake();
    const hooks = await hooksWith(state);
    await expect(hooks["tool.execute.before"]({ tool: "helpers_cancel", sessionID: "c2" }, { args: { id: "c1" } })).rejects.toThrow("helpers may not use helpers_cancel");
    await hooks["tool.execute.before"]({ tool: "helpers_status", sessionID: "root" }, { args: {} });
    await hooks["tool.execute.before"]({ tool: "bash", sessionID: "c2" }, { args: { command: "ls" } });
  });

  test("a helper tool call whose caller cannot be verified is refused, not let through", async () => {
    const state = fake();
    state.client.session!.get = async () => {
      throw new Error("server away");
    };
    const hooks = await hooksWith(state);
    await expect(hooks["tool.execute.before"]({ tool: "helpers_steer", sessionID: "unseen" }, { args: {} })).rejects.toThrow("an unknown agent may not use helpers_steer");
    // The shell guard keeps its earlier behaviour: a failed lookup is reported and the call goes on.
    await hooks["tool.execute.before"]({ tool: "bash", sessionID: "unseen" }, { args: { command: "git push" } });
  });

  test("a child announced by session.created is pinned even when the server is unreachable", async () => {
    const state = fake();
    state.client.session!.get = async () => {
      throw new Error("server away");
    };
    const hooks = await hooksWith(state);
    await created(hooks, "c9", "root");
    await hooks["chat.message"]({ sessionID: "c9", agent: "scout" }, { message: { agent: "scout" } });
    const fromTui = { agent: "lead", model: { providerID: "anthropic", modelID: "claude-opus-5-5", variant: "xhigh" } };
    await hooks["chat.message"]({ sessionID: "c9", agent: "lead" }, { message: fromTui });
    expect(fromTui).toEqual({ agent: "scout", model: { providerID: "anthropic", modelID: "claude-sonnet-5-5", variant: "medium" } });
  });

  test("a session that starts with /review stays the user's: the next message goes back to lead", async () => {
    const state = fake();
    const hooks = await hooksWith(state);
    // A root session: session.created without a parent, then the reviewer answering inline first.
    await created(hooks, "fresh");
    await hooks["chat.message"]({ sessionID: "fresh", agent: "reviewer" }, { message: { agent: "reviewer" } });
    await hooks["chat.params"]({ sessionID: "fresh", agent: "reviewer" }, {});
    const next = { agent: "lead", model: { providerID: "anthropic", modelID: "claude-opus-5-5", variant: "xhigh" } };
    await hooks["chat.message"]({ sessionID: "fresh", agent: "lead" }, { message: next });
    expect(next).toEqual({ agent: "lead", model: { providerID: "anthropic", modelID: "claude-opus-5-5", variant: "xhigh" } });
    expect(await shell(hooks, "fresh", "git push")).toBeUndefined();
    // The same without any event: the server says the session has no parent.
    await hooks["chat.message"]({ sessionID: "root", agent: "reviewer" }, { message: { agent: "reviewer" } });
    const again = { agent: "lead" };
    await hooks["chat.message"]({ sessionID: "root", agent: "lead" }, { message: again });
    expect(again.agent).toBe("lead");
  });

  test("when the parent cannot be known, nothing is pinned", async () => {
    const state = fake();
    state.client.session!.get = async () => {
      throw new Error("server away");
    };
    const hooks = await hooksWith(state);
    await hooks["chat.message"]({ sessionID: "mystery", agent: "scout" }, { message: { agent: "scout" } });
    const next = { agent: "lead" };
    await hooks["chat.message"]({ sessionID: "mystery", agent: "lead" }, { message: next });
    expect(next.agent).toBe("lead");
  });

  test("a child created before the plugin started is pinned to the agent of its first message, after the server confirms the parent", async () => {
    const state = fake();
    // No session.created was seen. The server record already names the sender, lead; the history
    // still starts with the builder.
    state.sessions.c2!.agent = "lead";
    state.client.session!.messages = async ({ path }) => ({
      data: path.id === "c2" ? [{ info: { role: "user", agent: "builder" } }, { info: { role: "assistant", agent: "builder" } }] : [],
    });
    const hooks = await hooksWith(state);
    const fromTui = { agent: "lead", model: { providerID: "anthropic", modelID: "claude-opus-5-5", variant: "xhigh" } };
    await hooks["chat.message"]({ sessionID: "c2", agent: "lead" }, { message: fromTui });
    expect(fromTui).toEqual({ agent: "builder", model: { providerID: "anthropic", modelID: "claude-sonnet-5-5", variant: "high" } });
    // From then on the session is the builder's for the tools and the guard.
    expect(await hooks.tool.helpers_status!.execute({}, { sessionID: "root", agent: "lead" })).toContain("c2, builder, running");
    await expect(hooks["tool.execute.before"]({ tool: "helpers_steer", sessionID: "c2" }, { args: {} })).rejects.toThrow("helpers may not use");
    // The user's own session, first seen mid-run, is left alone: the server says it has no parent.
    const own = { agent: "lead" };
    await hooks["chat.message"]({ sessionID: "root", agent: "lead" }, { message: own });
    expect(own.agent).toBe("lead");
  });

  test("a continued helper no longer shows its earlier stop or failure", async () => {
    const state = fake();
    const hooks = await hooksWith(state);
    expect(await hooks.tool.helpers_cancel!.execute({ id: "c1" }, { sessionID: "root", agent: "lead" })).toStartWith("Stopped scout c1.");
    expect(await hooks.tool.helpers_status!.execute({}, { sessionID: "root", agent: "lead" })).toContain("c1, scout, stopped");
    // lead continues it with task_id; the new message starts a new run that answers without a tool call.
    await hooks["chat.message"]({ sessionID: "c1", agent: "scout" }, { message: { agent: "scout" } });
    expect(await hooks.tool.helpers_status!.execute({}, { sessionID: "root", agent: "lead" })).toContain("c1, scout, idle");
  });

  test("a message that names another agent in a helper's child session is pinned to the helper; the user's own session is left alone", async () => {
    const state = fake();
    const hooks = await hooksWith(state);
    await created(hooks, "c2", "root");
    await hooks["chat.message"]({ sessionID: "c2", agent: "builder" }, { message: { agent: "builder", model: { providerID: "anthropic", modelID: "claude-sonnet-5-5", variant: "high" } } });
    const fromTui = { agent: "lead", model: { providerID: "anthropic", modelID: "claude-opus-5-5", variant: "xhigh" } };
    await hooks["chat.message"]({ sessionID: "c2", agent: "lead" }, { message: fromTui });
    expect(fromTui).toEqual({ agent: "builder", model: { providerID: "anthropic", modelID: "claude-sonnet-5-5", variant: "high" } });
    // A message that names the helper but another model or effort is pinned too.
    const sameAgent = { agent: "builder", model: { providerID: "anthropic", modelID: "claude-opus-5-5", variant: "max" } };
    await hooks["chat.message"]({ sessionID: "c2", agent: "builder" }, { message: sameAgent });
    expect(sameAgent.model).toEqual({ providerID: "anthropic", modelID: "claude-sonnet-5-5", variant: "high" });
    // The reviewer answered inline in the root session; the next message there is lead's.
    await hooks["chat.params"]({ sessionID: "root", agent: "reviewer" }, {});
    const next = { agent: "lead", model: { providerID: "anthropic", modelID: "claude-opus-5-5", variant: "xhigh" } };
    await hooks["chat.message"]({ sessionID: "root", agent: "lead" }, { message: next });
    expect(next.agent).toBe("lead");
    // After the pin, the session is known as the helper's again.
    await expect(hooks["tool.execute.before"]({ tool: "helpers_steer", sessionID: "c2" }, { args: {} })).rejects.toThrow("helpers may not use");
  });

  test("after a pin the server's record names the sender, but the tools still treat the session as the helper's", async () => {
    const state = fake();
    const hooks = await hooksWith(state);
    await created(hooks, "c2", "root");
    await hooks["chat.message"]({ sessionID: "c2", agent: "builder" }, { message: { agent: "builder" } });
    // opencode updates the record before the hook runs, so it says lead from now on.
    state.sessions.c2!.agent = "lead";
    await hooks["chat.message"]({ sessionID: "c2", agent: "lead" }, { message: { agent: "lead" } });
    expect(await hooks.tool.helpers_status!.execute({}, { sessionID: "root", agent: "lead" })).toContain("c2, builder, running");
    expect(await hooks.tool.helpers_steer!.execute({ id: "c2", text: "x" }, { sessionID: "root", agent: "lead" })).toContain("Sent to builder c2");
    expect(state.prompts.at(-1)?.agent).toBe("builder");
    expect(await hooks.tool.helpers_cancel!.execute({ id: "c2" }, { sessionID: "root", agent: "lead" })).toStartWith("Stopped builder c2.");
    // A lookup for an unseen session fills the record in; it never replaces a known one.
    expect(await hooks.tool.helpers_steer!.execute({ id: "c1", text: "x" }, { sessionID: "root", agent: "lead" })).toContain("Sent to scout c1");
  });

  test("a helper that is no longer busy is idle, failed after a session.error, or stopped after a cancel; never assumed done", async () => {
    const state = fake();
    const hooks = await hooksWith(state);
    state.busy.delete("c1");
    state.busy.delete("c2");
    await hooks.event({ event: { type: "session.error", properties: { sessionID: "c2" } } });
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "c1" } } });
    await hooks.event({});
    const status = await hooks.tool.helpers_status!.execute({}, { sessionID: "root", agent: "lead" });
    expect(status).toContain("c1, scout, idle");
    expect(status).toContain("c2, builder, failed");
  });
});

describe("v1 helper commands and completions in the user's own session", () => {
  const LEAD_MODEL = { providerID: "anthropic", modelID: "claude-opus-5-5", variant: "xhigh" };
  const REVIEWER_MODEL = { providerID: "github-copilot", modelID: "gpt-6.1-sol", variant: "medium" };
  const COMPLETION_TEXT = '<task id="ses_child" state="completed">\n<task_result>\nbuilder finished\n</task_result>\n</task>';

  interface Box {
    hooks: V1Hooks;
    busy: Set<string>;
    /** When set, reading the status fails. */
    statusFails: boolean;
    /** Pauses taken while waiting, and what to do at each. */
    pauses: number;
    onPause: (() => void) | undefined;
    clock: number;
  }

  async function box(limitMs = 60_000): Promise<Box> {
    const state = { busy: new Set<string>(), statusFails: false, pauses: 0, onPause: undefined as (() => void) | undefined, clock: 1_000 } as Box;
    const client: V1Client = {
      session: {
        get: async ({ path }) => ({ data: path.id === "child" ? { id: path.id, agent: "builder", parentID: "root" } : { id: path.id, agent: "lead" } }),
        status: async () => {
          if (state.statusFails) throw new Error("server away");
          return { data: Object.fromEntries([...state.busy].map((id) => [id, { type: "busy" }])) };
        },
      },
    };
    const plugin = createPlugin(harness, {
      environment: () => fakeEnvironment({}),
      schedule: (run) => run(),
      now: () => state.clock,
      inlineWaitLimitMs: limitMs,
      sleep: async (ms) => {
        state.pauses += 1;
        state.clock += ms;
        state.onPause?.();
      },
    });
    state.hooks = await plugin.server({ client, directory: "/repo", worktree: "/repo" });
    await state.hooks.event({ event: { type: "session.created", properties: { info: { id: "root" } } } });
    await state.hooks.event({ event: { type: "session.created", properties: { info: { id: "child", parentID: "root" } } } });
    return state;
  }

  /** lead's latest request in the user's session: it owns the session from then on. */
  const leadWorks = (b: Box) => b.hooks["chat.params"]({ sessionID: "root", agent: "lead", message: { model: { ...LEAD_MODEL } } }, {});
  /** The reviewer's request when it answers inline. */
  const reviewerWorks = (b: Box) => b.hooks["chat.params"]({ sessionID: "root", agent: "reviewer", message: { model: { ...REVIEWER_MODEL } } }, {});

  const reviewCommand = (session = "root") => ({
    message: { agent: "reviewer", model: { ...REVIEWER_MODEL }, time: { created: 5 } },
    parts: [{ id: "prt_1", sessionID: session, messageID: "msg_1", type: "text", text: "Review the uncommitted changes." }] as unknown[],
  });
  const completion = () => ({
    message: { agent: "reviewer", model: { ...REVIEWER_MODEL }, time: { created: 5 } },
    parts: [{ id: "prt_9", sessionID: "root", messageID: "msg_9", type: "text", synthetic: true, text: COMPLETION_TEXT }] as unknown[],
  });
  const send = async (b: Box, output: { message: V1UserMessage; parts: unknown[] }, session = "root", command?: string) => {
    if (command !== undefined) await b.hooks["command.execute.before"]({ command, sessionID: session, arguments: "" }, { parts: output.parts });
    await b.hooks["chat.message"]({ sessionID: session, agent: output.message.agent }, output);
    return output;
  };

  test("a helper command in an idle session answers inline: nothing changes", async () => {
    const b = await box();
    await leadWorks(b);
    const sent = await send(b, reviewCommand(), "root", "review");
    expect(sent.message).toEqual({ agent: "reviewer", model: REVIEWER_MODEL, time: { created: 5 } });
    expect((sent.parts[0] as { type: string }).type).toBe("text");
  });

  test("a helper command while lead works runs in a child session; the message becomes lead's, with lead's model", async () => {
    const b = await box();
    await leadWorks(b);
    b.busy.add("root");
    const sent = await send(b, reviewCommand(), "root", "review");
    expect(sent.parts).toEqual([
      {
        id: "prt_1",
        sessionID: "root",
        messageID: "msg_1",
        type: "subtask",
        prompt: "Review the uncommitted changes.",
        description: "Independent review of your changes",
        agent: "reviewer",
        model: { providerID: "github-copilot", modelID: "gpt-6.1-sol" },
        command: "review",
      },
    ]);
    expect(sent.message).toEqual({ agent: "lead", model: LEAD_MODEL, time: { created: 5 } });
    expect(b.pauses).toBe(0);
    // The session is lead's again for the shell guard.
    expect(await shell(b.hooks, "root", "git push")).toBeUndefined();
  });

  test("with no request seen yet, a converted command goes to the default agent with its configured model", async () => {
    const b = await box();
    b.busy.add("root");
    const sent = await send(b, reviewCommand(), "root", "review");
    expect((sent.parts[0] as { type: string }).type).toBe("subtask");
    expect(sent.message.agent).toBe("lead");
    expect(sent.message.model).toEqual({ providerID: "anthropic", modelID: "claude-opus-5-5", variant: "xhigh" });
  });

  test("a completion in an idle session goes to the owner, at once", async () => {
    const b = await box();
    await leadWorks(b);
    const sent = await send(b, completion());
    expect(sent.message).toEqual({ agent: "lead", model: LEAD_MODEL, time: { created: 5 } });
    expect((sent.parts[0] as { text: string }).text).toBe(COMPLETION_TEXT);
    expect(b.pauses).toBe(0);
  });

  test("a completion while lead works goes to lead at once, for lead's next step", async () => {
    const b = await box();
    await leadWorks(b);
    b.busy.add("root");
    const sent = await send(b, completion());
    expect(sent.message.agent).toBe("lead");
    expect(b.pauses).toBe(0);
  });

  test("a completion while the reviewer answers inline waits for the verdict, then goes to lead, dated at delivery", async () => {
    const b = await box();
    await leadWorks(b);
    await send(b, reviewCommand(), "root", "review");
    await reviewerWorks(b);
    b.busy.add("root");
    b.onPause = () => {
      if (b.pauses === 3) b.busy.delete("root");
    };
    const sent = await send(b, completion());
    expect(b.pauses).toBe(3);
    expect(sent.message).toEqual({ agent: "lead", model: LEAD_MODEL, time: { created: b.clock } });
    expect(b.clock).toBeGreaterThan(1_000);
  });

  test("a helper command while another answers inline waits for it, then answers inline too", async () => {
    const b = await box();
    await leadWorks(b);
    await send(b, reviewCommand(), "root", "review");
    await reviewerWorks(b);
    b.busy.add("root");
    b.onPause = () => b.busy.delete("root");
    const sent = await send(b, reviewCommand(), "root", "review");
    expect(b.pauses).toBe(1);
    expect(sent.message.agent).toBe("reviewer");
    expect(sent.message.time).toEqual({ created: b.clock });
    expect((sent.parts[0] as { type: string }).type).toBe("text");
  });

  test("a helper still answering at the limit keeps the completion, as opencode wrote it", async () => {
    const b = await box(1_000);
    await leadWorks(b);
    await reviewerWorks(b);
    b.busy.add("root");
    const sent = await send(b, completion());
    expect(b.pauses).toBeGreaterThan(0);
    expect(sent.message).toEqual({ agent: "reviewer", model: REVIEWER_MODEL, time: { created: 5 } });
  });

  test("when the session's state cannot be read, messages stay as opencode made them", async () => {
    const b = await box();
    await leadWorks(b);
    b.statusFails = true;
    const command = await send(b, reviewCommand(), "root", "review");
    expect(command.message.agent).toBe("reviewer");
    expect((command.parts[0] as { type: string }).type).toBe("text");
    const done = await send(b, completion());
    expect(done.message.agent).toBe("reviewer");
  });

  test("a helper's child session is left to pinning: a command there never becomes a subtask", async () => {
    const b = await box();
    await b.hooks["chat.message"]({ sessionID: "child", agent: "builder" }, { message: { agent: "builder" } });
    b.busy.add("child");
    const sent = await send(b, reviewCommand("child"), "child", "review");
    expect(sent.message.agent).toBe("builder");
    expect((sent.parts[0] as { type: string }).type).toBe("text");
  });

  test("a completion that arrives between a command and its message does not take the command's name", async () => {
    const b = await box();
    await leadWorks(b);
    await b.hooks["command.execute.before"]({ command: "review", sessionID: "root", arguments: "" }, { parts: [] });
    await send(b, completion());
    b.busy.add("root");
    const sent = await send(b, reviewCommand());
    expect((sent.parts[0] as { command?: string }).command).toBe("review");
  });

  test("lead's own message is never touched, and makes lead the owner with its model", async () => {
    const b = await box();
    b.busy.add("root");
    const own = { message: { agent: "lead", model: { providerID: "anthropic", modelID: "claude-sonnet-5-5" } }, parts: [{ type: "text", text: "go on" }] as unknown[] };
    await send(b, own);
    expect(own.message).toEqual({ agent: "lead", model: { providerID: "anthropic", modelID: "claude-sonnet-5-5" } });
    b.busy.delete("root");
    const sent = await send(b, completion());
    expect(sent.message.model).toEqual({ providerID: "anthropic", modelID: "claude-sonnet-5-5" });
  });
});

test("v1: a status call that never answers leaves a helper command as it is, after the lookup timeout", async () => {
  const client: V1Client = {
    session: {
      get: async ({ path }) => ({ data: { id: path.id, agent: "lead" } }),
      status: () => new Promise(() => undefined),
    },
  };
  const plugin = createPlugin(harness, { environment: () => fakeEnvironment({}), schedule: (run) => run() });
  const hooks = await plugin.server({ client, directory: "/repo", worktree: "/repo" });
  await hooks.event({ event: { type: "session.created", properties: { info: { id: "root" } } } });
  const output = { message: { agent: "reviewer" }, parts: [{ type: "text", text: "Review" }] as unknown[] };
  const started = Date.now();
  await hooks["chat.message"]({ sessionID: "root", agent: "reviewer" }, output);
  expect(Date.now() - started).toBeLessThan(5_000);
  expect(output.message.agent).toBe("reviewer");
  expect((output.parts[0] as { type: string }).type).toBe("text");
}, 10_000);
