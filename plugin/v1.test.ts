// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { createPlugin } from "./plugin.ts";
import { LEAD_PROMPT, embeddedFixture, fakeEnvironment } from "./testing.ts";
import type { Environment, V1Client, V1Config, V1Hooks } from "./types.ts";
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

  test("an agent switch in a session is followed", async () => {
    const hooks = await start({});
    await hooks["chat.message"]({ sessionID: "s" }, { message: { agent: "builder" } });
    expect(await shell(hooks, "s", "git push")).toBeDefined();
    await hooks["chat.message"]({ sessionID: "s" }, { message: { agent: "lead" } });
    expect(await shell(hooks, "s", "git push")).toBeUndefined();
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
