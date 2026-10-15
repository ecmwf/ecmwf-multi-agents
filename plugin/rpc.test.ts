// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { ProblemLog, agentFiles, doctorReport, registerRpc, type DoctorInput } from "./rpc.ts";
import { loadSettings } from "./settings.ts";
import { embeddedFixture, fakeEnvironment } from "./testing.ts";
import type { V2Context, V2RpcDefinition } from "./types.ts";
import { createTui, type TuiContext } from "./tui.ts";

const harness = embeddedFixture();
const GLOBAL = "/home/user/.config/opencode";

function input(files: Record<string, string>, agents: unknown, plugins: unknown = []): DoctorInput {
  const environment = fakeEnvironment(files);
  const ctx = {
    agent: { transform: async () => ({ dispose: async () => {} }), list: async () => agents },
    plugin: { list: async () => plugins },
  } as unknown as V2Context;
  return { harness, ctx, loaded: loadSettings(harness, environment, "/repo"), problems: new ProblemLog(), environment, directory: "/repo/sub", projectRoot: "/repo" };
}

describe("doctor", () => {
  test("reports lead from the plugin, its review line, the settings with their files, problems and plugins", async () => {
    const doctor = input(
      { [`${GLOBAL}/ecmwf-multi-agents.jsonc`]: '{ "review": "always", "agents": { "scout": { "steps": 9 } } }' },
      { data: [{ id: "lead", system: "Hi.\nReview policy: always\nBye.", model: { providerID: "p", id: "m", variant: "high" } }, { id: "build" }] },
      [
        { id: "opencode.agent", state: { status: "active" } },
        { id: "opencode.broken", state: { status: "failed", error: "boom" } },
        { id: "ecmwf-multi-agents", state: { status: "active" } },
        { id: "ecmwf-multi-agents", state: { status: "failed", error: "Duplicate plugin ID: ecmwf-multi-agents" } },
      ],
    );
    doctor.problems.add({ message: "x: something", notify: true });
    expect(await doctorReport(doctor)).toEqual({
      name: "ecmwf-multi-agents",
      version: harness.version,
      defaultAgent: "lead",
      leadLoaded: true,
      leadSource: "plugin",
      leadFiles: [],
      reviewLine: "Review policy: always",
      leadModel: "p/m#high",
      settings: { review: "always", profile: "default", default_agent: true, agents: { scout: { steps: 9 } } },
      settingsFiles: [`${GLOBAL}/ecmwf-multi-agents.jsonc`],
      settingsSources: { review: `${GLOBAL}/ecmwf-multi-agents.jsonc`, "agents.scout.steps": `${GLOBAL}/ecmwf-multi-agents.jsonc` },
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

  test("lead from files, and lead missing", async () => {
    const files = { "/repo/.opencode/agents/lead.md": "---\n---\nx", [`${GLOBAL}/agent/lead.md`]: "x" };
    const fromFiles = await doctorReport(input(files, [{ id: "lead", system: "x" }]));
    expect(fromFiles).toMatchObject({ leadLoaded: true, leadSource: "files", reviewLine: null, leadModel: null });
    expect(fromFiles.leadFiles).toEqual([`${GLOBAL}/agent/lead.md`, "/repo/.opencode/agents/lead.md"]);
    expect(await doctorReport(input({}, [{ id: "build" }]))).toMatchObject({ defaultAgent: "build", leadLoaded: false, leadSource: null });
  });

  test("agent files are looked for in the site and global folders and in .opencode up to the project root", () => {
    const environment = fakeEnvironment({ "/site/agents/lead.md": "x", "/repo/sub/.opencode/modes/lead.md": "x", "/.opencode/agents/lead.md": "x" }, { OPENCODE_CONFIG_DIR: "/site" });
    expect(agentFiles("lead", environment, "/repo/sub", "/repo")).toEqual(["/site/agents/lead.md", "/repo/sub/.opencode/modes/lead.md"]);
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
