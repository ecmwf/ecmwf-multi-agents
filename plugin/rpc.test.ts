// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { applyToV2Agents, planAgents } from "./apply.ts";
import { applyAgent } from "./register.ts";
import { ProblemLog, agentConfigFiles, agentFiles, doctorReport, registerRpc, type DoctorInput } from "./rpc.ts";
import { loadSettings } from "./settings.ts";
import { embeddedFixture, fakeEnvironment } from "./testing.ts";
import type { V2AgentInfo, V2Context, V2RpcDefinition } from "./types.ts";
import { createTui, type TuiContext } from "./tui.ts";

const harness = embeddedFixture();
const GLOBAL = "/home/user/.config/opencode";

function input(files: Record<string, string>, agents: unknown, plugins: unknown = [], env: Record<string, string> = {}): DoctorInput {
  const environment = fakeEnvironment(files, env);
  const ctx = {
    agent: { transform: async () => ({ dispose: async () => {} }), list: async () => agents },
    plugin: { list: async () => plugins },
  } as unknown as V2Context;
  return { harness, ctx, loaded: loadSettings(harness, environment, "/repo"), problems: new ProblemLog(), environment, directory: "/repo/sub", projectRoot: "/repo" };
}

const DEFAULT_RULES = [{ action: "*", resource: "*", effect: "allow" }];
const GLOBAL_ALLOW = { action: "shell", resource: "*", effect: "allow" };

/** lead as opencode loads it from the plugin: created with opencode's defaults, the config's rules, then the settings. */
function loadedLead(files: Record<string, string>, change: (agent: V2AgentInfo) => void = () => {}): V2AgentInfo {
  const environment = fakeEnvironment(files);
  const { settings } = loadSettings(harness, environment, "/repo");
  const agent: V2AgentInfo = { id: "lead", mode: "primary", hidden: false, permissions: [...DEFAULT_RULES] };
  applyAgent(agent, harness.agents.find((item) => item.id === "lead")!, environment.home);
  // The user's global rule, moved before the harness's own as the rule order does.
  agent.permissions!.splice(DEFAULT_RULES.length, 0, GLOBAL_ALLOW);
  change(agent);
  const editor = { list: () => [agent], get: (id: string) => (id === "lead" ? agent : undefined), default: () => {}, update: (_: string, update: (agent: V2AgentInfo) => void) => update(agent) };
  applyToV2Agents(editor, harness, settings, planAgents(harness, settings).plans);
  return agent;
}

const ALWAYS = { [`${GLOBAL}/ecmwf-multi-agents.jsonc`]: '{ "review": "always", "profile": "copilot", "agents": { "scout": { "steps": 9 }, "lead": { "steps": 40 } } }' };

describe("doctor", () => {
  test("reports the harness's lead, its review line, the settings with their files, problems and plugins", async () => {
    const lead = loadedLead(ALWAYS);
    expect(lead.model).toEqual({ providerID: "github-copilot", id: "claude-opus-5.5", variant: "xhigh" });
    const doctor = input(ALWAYS, { data: [lead, { id: "build" }] }, [
      { id: "opencode.agent", state: { status: "active" } },
      { id: "opencode.broken", state: { status: "failed", error: "boom" } },
      { id: "ecmwf-multi-agents", state: { status: "active" } },
      { id: "ecmwf-multi-agents", state: { status: "failed", error: "Duplicate plugin ID: ecmwf-multi-agents" } },
    ]);
    doctor.problems.add({ message: "x: something", notify: true });
    const file = `${GLOBAL}/ecmwf-multi-agents.jsonc`;
    expect(await doctorReport(doctor)).toEqual({
      name: "ecmwf-multi-agents",
      version: harness.version,
      defaultAgent: "lead",
      leadLoaded: true,
      leadDefinition: "harness",
      leadChanged: [],
      leadCandidateFiles: [],
      leadConfigFiles: [],
      reviewLine: "Review policy: always",
      leadModel: "github-copilot/claude-opus-5.5#xhigh",
      settings: { review: "always", profile: "copilot", default_agent: true, agents: { scout: { steps: 9 }, lead: { steps: 40 } } },
      settingsFiles: [file],
      settingsSources: { review: file, profile: file, "agents.scout.steps": file, "agents.lead.steps": file },
      problems: [{ problem: "x: something", notify: true }],
      plugins: [
        { id: "opencode.broken", status: "failed", error: "boom" },
        { id: "ecmwf-multi-agents", status: "active" },
        { id: "ecmwf-multi-agents", status: "failed", error: "Duplicate plugin ID: ecmwf-multi-agents" },
      ],
    });
  });

  test("waits for the settings to reach the agents before it reads them", async () => {
    const state = { system: "Review policy: auto" };
    const doctor = input({}, []);
    doctor.ctx.agent.list = async () => [{ id: "lead", system: state.system }];
    doctor.ready = async () => {
      await Bun.sleep(5);
      state.system = "Review policy: never";
    };
    expect(await doctorReport(doctor)).toMatchObject({ reviewLine: "Review policy: never" });
    doctor.ready = async () => Promise.reject(new Error("no"));
    expect(await doctorReport(doctor)).toMatchObject({ leadLoaded: true });
  });

  test("lead changed through a config entry, with no agent file", async () => {
    const files = { ...ALWAYS, "/repo/opencode.jsonc": '{ // mine\n "agents": { "lead": { "description": "Mine." } } }' };
    const lead = loadedLead(files, (agent) => (agent.description = "Mine."));
    expect(await doctorReport(input(files, [lead]))).toMatchObject({
      leadDefinition: "changed",
      leadChanged: ["description"],
      leadCandidateFiles: [],
      leadConfigFiles: ["/repo/opencode.jsonc"],
    });
  });

  test("a lead.md that changes nothing: the harness's lead, the file a candidate only", async () => {
    const files = { ...ALWAYS, "/repo/.opencode/agents/lead.md": "---\n---\nx" };
    expect(await doctorReport(input(files, [loadedLead(files)]))).toMatchObject({
      leadDefinition: "harness",
      leadChanged: [],
      leadCandidateFiles: ["/repo/.opencode/agents/lead.md"],
      leadConfigFiles: [],
    });
  });

  test("each field that differs is named", async () => {
    const changed = async (change: (agent: V2AgentInfo) => void) => (await doctorReport(input(ALWAYS, [loadedLead(ALWAYS, change)]))).leadChanged;
    expect(await changed((agent) => (agent.system = `${agent.system}\nMore.`))).toEqual(["system"]);
    expect(await changed((agent) => (agent.mode = "all"))).toEqual(["mode"]);
    expect(await changed((agent) => (agent.hidden = true))).toEqual(["hidden"]);
    expect(await changed((agent) => (agent.color = "red"))).toEqual(["color"]);
    // A missing or reordered rule; extra rules around the harness's own are the user's.
    expect(await changed((agent) => agent.permissions!.splice(-1, 1))).toEqual(["permissions"]);
    expect(await changed((agent) => agent.permissions!.splice(-2, 0, GLOBAL_ALLOW))).toEqual(["permissions"]);
    expect(await changed((agent) => agent.permissions!.push(GLOBAL_ALLOW))).toEqual([]);
    // The settings decide model, effort and steps, so only something after them changes these.
    const lead = loadedLead(ALWAYS);
    const after = async (change: (agent: V2AgentInfo) => void) => {
      const copy = structuredClone(lead);
      change(copy);
      return (await doctorReport(input(ALWAYS, [copy]))).leadChanged;
    };
    expect(await after((agent) => (agent.model = { providerID: "p", id: "m", variant: "xhigh" }))).toEqual(["model"]);
    expect(await after((agent) => (agent.model = { ...agent.model!, variant: "low" }))).toEqual(["effort"]);
    expect(await after((agent) => (agent.steps = 3))).toEqual(["steps"]);
    expect(await after((agent) => delete agent.system)).toEqual(["system"]);
  });

  test("the review policy the settings choose is not a change; with no settings, the harness's own lead", async () => {
    expect(await doctorReport(input({}, [loadedLead({})]))).toMatchObject({ leadDefinition: "harness", reviewLine: "Review policy: auto", leadModel: "anthropic/claude-opus-5-5#xhigh" });
  });

  test("lead missing", async () => {
    expect(await doctorReport(input({}, [{ id: "build" }]))).toMatchObject({ defaultAgent: "build", leadLoaded: false, leadDefinition: null, leadChanged: [] });
  });

  test("agent files are looked for in the global folder opencode uses and in .opencode up to the project root", () => {
    const files = { "/site/agents/lead.md": "x", [`${GLOBAL}/agents/lead.md`]: "x", "/repo/sub/.opencode/modes/lead.md": "x", "/.opencode/agents/lead.md": "x" };
    // OPENCODE_CONFIG_DIR replaces the user's global folder, so a lead.md left there is not loaded.
    const replaced = fakeEnvironment(files, { OPENCODE_CONFIG_DIR: "/site" });
    expect(agentFiles("lead", replaced, "/repo/sub", "/repo")).toEqual(["/site/agents/lead.md", "/repo/sub/.opencode/modes/lead.md"]);
    expect(agentFiles("lead", fakeEnvironment(files), "/repo/sub", "/repo")).toEqual([`${GLOBAL}/agents/lead.md`, "/repo/sub/.opencode/modes/lead.md"]);
  });

  test("configs with a lead entry: the global folder, OPENCODE_CONFIG, the project up to its root, OPENCODE_CONFIG_CONTENT", () => {
    const lead = '{ "agents": { "lead": {} } }';
    const files = {
      [`${GLOBAL}/opencode.json`]: '{ "agent": { "lead": { "steps": 3 } } }',
      [`${GLOBAL}/opencode.jsonc`]: '{ "agents": { "scout": {} } }',
      "/site/central.json": lead,
      "/repo/sub/.opencode/opencode.jsonc": lead,
      "/repo/opencode.json": "{ not json",
      "/repo/.opencode/opencode.json": lead,
      "/opencode.json": lead,
    };
    const environment = fakeEnvironment(files, { OPENCODE_CONFIG: "/site/central.json", OPENCODE_CONFIG_CONTENT: lead });
    expect(agentConfigFiles("lead", environment, "/repo/sub", "/repo")).toEqual([
      `${GLOBAL}/opencode.json`,
      "/site/central.json",
      "/repo/sub/.opencode/opencode.jsonc",
      "/repo/.opencode/opencode.json",
      "OPENCODE_CONFIG_CONTENT",
    ]);
    expect(agentConfigFiles("lead", fakeEnvironment({}), undefined, undefined)).toEqual([]);
  });

  test("lead registered by the plugin: a lead.md opencode ignores is no candidate", async () => {
    const ignored = await doctorReport(input({ [`${GLOBAL}/agents/lead.md`]: "x" }, [loadedLead({})], [], { OPENCODE_CONFIG_DIR: "/site" }));
    expect(ignored).toMatchObject({ leadLoaded: true, leadDefinition: "harness", leadCandidateFiles: [] });
  });
});

describe("the RPC", () => {
  test("registers doctor and problems, and publishes each new problem as an event", async () => {
    const doctor = input({}, []);
    let definition: V2RpcDefinition | undefined;
    let handlers: Record<string, (input: unknown) => Promise<unknown>> = {};
    const events: Array<[string, unknown]> = [];
    doctor.ctx.rpc = {
      register: async (given, given2) => {
        definition = given;
        handlers = given2;
        return { dispose: async () => {}, events: { emit: async (name, data) => void events.push([name, data]) } };
      },
    };
    doctor.problems.add({ message: "before", notify: false });
    await registerRpc(doctor);
    expect(definition).toEqual({
      id: "ecmwf-multi-agents",
      methods: { doctor: { input: {}, output: {} }, problems: { input: {}, output: {} } },
      events: { problem: { schema: { type: "object" } } },
    });
    doctor.problems.add({ message: "after", notify: true });
    doctor.problems.add({ message: "after", notify: true });
    expect(events).toEqual([["problem", { problem: "after", notify: true }]]);
    expect(await handlers.problems!({})).toEqual({
      problems: [
        { problem: "before", notify: false },
        { problem: "after", notify: true },
      ],
    });
    expect(await handlers.doctor!({})).toMatchObject({ name: "ecmwf-multi-agents", leadLoaded: false });
  });

  test("an opencode without RPC: nothing registered", async () => {
    expect(await registerRpc(input({}, []))).toBeUndefined();
  });
});

describe("the TUI entry", () => {
  function tui(problems: unknown, fail = false) {
    const toasts: Array<Record<string, unknown>> = [];
    const calls: unknown[] = [];
    let handler: ((event: { data?: unknown }) => void) | undefined;
    let off = 0;
    const ctx: TuiContext = {
      location: { directory: "/repo" },
      client: {
        rpc: (definition) => {
          calls.push(definition.id);
          return {
            problems: async (_input, options) => {
              calls.push(options);
              if (fail) throw { type: "rpc.unavailable", message: "RPC is unavailable" };
              return problems;
            },
            events: {
              on: (name, given) => {
                calls.push(name);
                handler = given;
                return () => void off++;
              },
            },
          };
        },
      },
      ui: { toast: { show: (options) => void toasts.push(options) } },
    };
    return { ctx, toasts, calls, emit: (data: unknown) => handler?.({ data }), off: () => off };
  }

  test("shows each problem worth a toast once, from the start and from events; cleanup stops listening", async () => {
    const host = tui({ problems: [{ problem: "a", notify: true }, { problem: "quiet", notify: false }] });
    const plugin = createTui("ecmwf-multi-agents");
    expect(plugin.id).toBe("ecmwf-multi-agents");
    const cleanup = plugin.setup(host.ctx);
    await Bun.sleep(1);
    host.emit({ problem: "b", notify: true });
    host.emit({ problem: "a", notify: true });
    host.emit("nonsense");
    expect(host.calls).toEqual(["ecmwf-multi-agents", "problem", { location: { directory: "/repo" } }]);
    expect(host.toasts).toEqual([
      { title: "ecmwf-multi-agents", message: "a", variant: "warning", duration: 10_000 },
      { title: "ecmwf-multi-agents", message: "b", variant: "warning", duration: 10_000 },
    ]);
    cleanup();
    expect(host.off()).toBe(1);
  });

  test("no RPC where the server plugin is not active: no toast, no error", async () => {
    const host = tui(undefined, true);
    createTui("ecmwf-multi-agents").setup(host.ctx);
    await Bun.sleep(1);
    expect(host.toasts).toEqual([]);
  });
});
