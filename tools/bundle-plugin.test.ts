// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { helperIds } from "../plugin/helpers.ts";
import { inlineCommands } from "../plugin/inline.ts";
import { resolvedFixture } from "../plugin/testing.ts";
import { HARNESS_CONSTANT, bundlePlugin, embedHarness, matterContent, pluginMarker, runtimeImports } from "./bundle-plugin.ts";
import { load } from "./load.ts";
import { resolveHarness } from "./resolve.ts";

const root = path.resolve(import.meta.dir, "..");

describe("bundlePlugin", () => {
  let first = "";
  let second = "";
  let dir = "";
  let file = "";

  beforeAll(async () => {
    first = await bundlePlugin(root, resolvedFixture());
    second = await bundlePlugin(root, resolvedFixture());
    dir = mkdtempSync(path.join(os.tmpdir(), "ecmwf-multi-agents-bundle-"));
    file = path.join(dir, "ecmwf-multi-agents.js");
    writeFileSync(file, first);
  });

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("starts with the marker line", () => {
    expect(first.split("\n")[0]).toBe("// managed by ecmwf-multi-agents");
  });

  test("uses LF line endings and ends with one newline", () => {
    expect(first).not.toContain("\r");
    expect(first.endsWith("\n")).toBe(true);
    expect(first.endsWith("\n\n")).toBe(false);
  });

  test("is the same for the same input", () => {
    expect(second).toBe(first);
  });

  test("holds no absolute paths and no timestamps", () => {
    expect(first).not.toContain(root);
    expect(first).not.toContain(os.homedir());
    expect(first).not.toMatch(/\b20\d\d-\d\d-\d\dT\d\d:/);
  });

  test("imports only runtime built-ins", () => {
    expect(runtimeImports(first).every((specifier) => /^(node:)?(fs|os|path|url)$/.test(specifier))).toBe(true);
    expect(first).not.toContain(HARNESS_CONSTANT);
  });

  test("embeds the profiles", () => {
    expect(first).toContain('"anthropic/claude-opus-5-5"');
  });

  test("exports one default object with id and setup", async () => {
    const module = (await import(file)) as Record<string, unknown>;
    expect(Object.keys(module)).toEqual(["default"]);
    const plugin = module.default as Record<string, unknown>;
    expect(Object.keys(plugin)).toEqual(["id", "setup"]);
    expect(plugin.id).toBe("ecmwf-multi-agents");
    expect(typeof plugin.setup).toBe("function");
  });

  test("the bundled module reads settings and applies the embedded profiles", () => {
    const home = path.join(dir, "home");
    const project = path.join(dir, "project");
    mkdirSync(path.join(home, ".config", "opencode"), { recursive: true });
    mkdirSync(path.join(project, ".opencode"), { recursive: true });
    writeFileSync(path.join(home, ".config", "opencode", "ecmwf-multi-agents.jsonc"), '{ "profile": "anthropic" }');
    writeFileSync(
      path.join(project, ".opencode", "ecmwf-multi-agents.jsonc"),
      '{ "review": "never", "agents": { "scout": { "steps": 9, "effort": "high" } } }',
    );
    const script = `
      const plugin = (await import(${JSON.stringify(file)})).default;
      const transforms = [];
      const hooks = [];
      const ctx = {
        location: { directory: ${JSON.stringify(project)}, project: { directory: ${JSON.stringify(project)} } },
        agent: { transform: async (callback) => { transforms.push(callback); return { dispose: async () => {} }; } },
        event: { subscribe: async function* () { yield { type: "plugin.updated" }; } },
        tool: { hook: async (_name, callback) => { hooks.push(callback); return { dispose: async () => {} }; } },
      };
      await plugin.setup(ctx);
      await new Promise((resolve) => setTimeout(resolve, 50));
      const agents = new Map();
      let selected;
      const editor = {
        list: () => [...agents.values()],
        get: (id) => agents.get(id),
        default: (id) => { selected = id; },
        update: (id, change) => { const agent = agents.get(id) ?? { id }; agents.set(id, agent); change(agent); },
      };
      // The registration transform comes first, then opencode's loader for the agent files, then the late transform.
      transforms[0](editor);
      editor.update("lead", (agent) => Object.assign(agent, { mode: "primary", system: "x\\nReview policy: auto\\ny" }));
      editor.update("scout", (agent) => Object.assign(agent, { mode: "subagent", steps: 15, model: { id: "claude-sonnet-5-5", providerID: "anthropic", variant: "medium" } }));
      editor.update("reviewer", (agent) => Object.assign(agent, { mode: "subagent", model: { id: "gpt-6.1-sol", providerID: "github-copilot", variant: "medium" } }));
      for (const transform of transforms.slice(1)) transform(editor);
      let blocked = "";
      try { for (const hook of hooks) await hook({ tool: "helpers_status", sessionID: "s", agent: "builder" }); }
      catch (error) { blocked = error.message; }
      console.log(JSON.stringify({ selected, agents: Object.fromEntries(agents), blocked }));
    `;
    const result = Bun.spawnSync(["bun", "-e", script], {
      env: { PATH: process.env.PATH ?? "", HOME: home, XDG_CONFIG_HOME: path.join(home, ".config") },
      cwd: dir,
    });
    expect(result.stderr.toString()).toBe("");
    const { selected, agents, blocked } = JSON.parse(result.stdout.toString()) as {
      selected?: string;
      agents: Record<string, Record<string, unknown>>;
      blocked: string;
    };
    expect(selected).toBe("lead");
    expect(agents.reviewer).toMatchObject({ id: "reviewer", mode: "subagent", model: { id: "claude-opus-5-5", providerID: "anthropic", variant: "high" } });
    expect(agents.scout).toMatchObject({ id: "scout", mode: "subagent", steps: 9, model: { id: "claude-sonnet-5-5", providerID: "anthropic", variant: "high" } });
    expect(agents.builder).toMatchObject({ id: "builder", mode: "subagent", system: "You are builder.", steps: 60 });
    expect(agents.lead!.system).toBe("x\nReview policy: never\ny");
    expect(blocked).toContain("helpers may not use helpers_status");
  });
});

describe("embedHarness", () => {
  test("keeps what the plugin needs: profiles, agents with their mode, and the helpers' commands", () => {
    const data = embedHarness(resolvedFixture());
    expect(Object.keys(data)).toEqual(["name", "version", "defaultAgent", "defaultProfile", "profiles", "agents", "commands", "skills"]);
    expect(data.profiles.map((profile) => profile.id)).toEqual(["anthropic", "copilot", "default", "inherit"]);
    expect(data.profiles.find((profile) => profile.id === "default")!.agents).toEqual({
      lead: { model: "anthropic/claude-opus-5-5", effort: "xhigh" },
      scout: { model: "anthropic/claude-sonnet-5-5", effort: "medium" },
      builder: { model: "anthropic/claude-sonnet-5-5", effort: "high" },
      reviewer: { model: "github-copilot/gpt-6.1-sol", effort: "medium" },
    });
    expect(data.agents.map((agent) => [agent.id, agent.mode])).toEqual([
      ["lead", "primary"],
      ["scout", "subagent"],
      ["builder", "subagent"],
      ["reviewer", "subagent"],
    ]);
  });

  test("from src/: lead and three helpers; review and progress answered inline", async () => {
    const data = embedHarness(resolveHarness(await load(root)));
    expect(data.agents.map((agent) => [agent.id, agent.mode])).toEqual([
      ["lead", "primary"],
      ["scout", "subagent"],
      ["builder", "subagent"],
      ["reviewer", "subagent"],
    ]);
    const inline = inlineCommands(data, helperIds(data));
    expect(inline.map((command) => [command.name, command.agent])).toEqual([
      ["review", "reviewer"],
      ["progress", "scout"],
    ]);
    expect(inline[0]!.template).toContain("Target: $ARGUMENTS");
  });

  test("agents, commands and skills are what the generated files say, as opencode reads them", () => {
    const data = embedHarness(resolvedFixture());
    const scout = data.agents.find((agent) => agent.id === "scout")!;
    expect(scout).toMatchObject({ description: "Read-only lookups and investigations in code, docs or the web.", model: "anthropic/claude-sonnet-5-5#medium", steps: 30, system: "You are scout." });
    expect(scout.permissions![0]).toEqual({ action: "edit", resource: "*", effect: "deny" });
    expect(scout.permissions).toContainEqual({ action: "subagent", resource: "*", effect: "deny" });
    expect(scout.permissions).toContainEqual({ action: "helpers_status", resource: "*", effect: "deny" });
    expect(data.agents.find((agent) => agent.id === "lead")).toMatchObject({ color: "#0b5394", model: "anthropic/claude-opus-5-5#xhigh" });
    expect(data.commands).toEqual([
      { name: "plan", description: "Plan a piece of work with you", agent: "lead", template: "Plan: $ARGUMENTS" },
      { name: "review", description: "Independent review of your changes", agent: "reviewer", subagent: true, template: "Review $ARGUMENTS" },
      { name: "progress", description: "Show progress on the current plan", agent: "scout", subagent: true, template: "Progress of $ARGUMENTS" },
    ]);
    expect(data.skills).toEqual([
      { id: "ecmwf-multi-agents-plan", name: "ecmwf-multi-agents-plan", description: "Plan file format and rules.", autoinvoke: false, content: "\n# Plan\n\nRules.\n" },
    ]);
  });

  test("matterContent keeps what gray-matter keeps after the frontmatter", () => {
    expect(matterContent("---\na: 1\n---\n\nBody\n")).toBe("\nBody\n");
    expect(matterContent("---\na: 1\n---\r\nBody")).toBe("Body");
    expect(matterContent("---\na: 1\n")).toBe("");
    expect(matterContent("No frontmatter")).toBe("No frontmatter");
  });

  test("orders profile entries by agent, whatever the order in the profile file", () => {
    const harness = resolvedFixture();
    const reversed = Object.fromEntries(Object.entries(harness.profiles[0]!.agents).reverse());
    harness.profiles[0]!.agents = reversed;
    expect(Object.keys(embedHarness(harness).profiles[0]!.agents)).toEqual(["lead", "scout", "builder", "reviewer"]);
  });

  test("refuses data the plugin could not use", () => {
    const cases: Array<[string, (harness: ReturnType<typeof resolvedFixture>) => void]> = [
      ["agent ids are not unique", (h) => h.agents.push(structuredClone(h.agents[0]!))],
      ["profile ids are not unique", (h) => h.profiles.push(structuredClone(h.profiles[0]!))],
      ['default profile "fast" is not a profile', (h) => (h.defaultProfile = "fast")],
      ['default agent "scout" is not a primary agent', (h) => (h.defaultAgent = "scout")],
      ["profile inherit names unknown agents: build", (h) => (h.profiles[3]!.agents = { build: { model: "a/b" } })],
      ["profile inherit: lead has an effort but no model", (h) => (h.profiles[3]!.agents = { lead: { effort: "high" } })],
      ['command review names unknown agent "auditor"', (h) => (h.commands[1]!.agent = "auditor")],
      ["command plan: the template runs a shell command", (h) => (h.commands[0]!.template = "Branch: !`git branch`")],
    ];
    for (const [message, change] of cases) {
      const harness = resolvedFixture();
      change(harness);
      expect(() => embedHarness(harness)).toThrow(`bundle-plugin: ${message}`);
    }
  });
});

test("pluginMarker turns the YAML marker into a JavaScript comment", () => {
  expect(pluginMarker({ marker: "# managed by ecmwf-multi-agents" })).toBe("// managed by ecmwf-multi-agents");
  expect(() => pluginMarker({ marker: "managed by x" })).toThrow("is not a single");
  expect(() => pluginMarker({ marker: "# a\nb" })).toThrow("is not a single");
});

test("runtimeImports finds static, dynamic and re-exported modules", () => {
  const code = `import { a } from "node:fs";\nimport b from "left-pad";\nimport "side";\nexport { c } from "./c.js";\nconst d = await import("dyn");\nconst e = require("req");\nconst s = "import x";`;
  expect(runtimeImports(code)).toEqual(["./c.js", "dyn", "left-pad", "node:fs", "req", "side"]);
});
