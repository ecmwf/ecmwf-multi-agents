// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkShellCommand } from "../plugin/guard.ts";
import { resolvedFixture } from "../plugin/testing.ts";
import { HARNESS_CONSTANT, bundlePlugin, embedHarness, pluginMarker, runtimeImports } from "./bundle-plugin.ts";
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
    expect(runtimeImports(first).every((specifier) => /^(node:)?(fs|os|path)$/.test(specifier))).toBe(true);
    expect(first).not.toContain(HARNESS_CONSTANT);
  });

  test("embeds the harness data", () => {
    expect(first).toContain('"anthropic/claude-opus-5-5"');
    expect(first).toContain('"git push *"');
    expect(first).not.toContain("You are scout.");
  });

  test("exports one default object with id, server and setup", async () => {
    const module = (await import(file)) as Record<string, unknown>;
    expect(Object.keys(module)).toEqual(["default"]);
    const plugin = module.default as { id: unknown; server: unknown; setup: unknown };
    expect(plugin.id).toBe("ecmwf-multi-agents");
    expect(typeof plugin.server).toBe("function");
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
      const hooks = await plugin.server({ directory: ${JSON.stringify(project)}, worktree: ${JSON.stringify(project)} });
      const config = { agent: {
        lead: { mode: "primary", prompt: "x\\nReview policy: auto\\ny" },
        scout: { mode: "subagent", model: "anthropic/claude-sonnet-5-5", variant: "medium", steps: 15 },
        reviewer: { mode: "subagent", model: "github-copilot/gpt-6.1-sol", variant: "medium" },
      } };
      await hooks.config(config);
      let blocked = "";
      await hooks["chat.message"]({ sessionID: "s" }, { message: { agent: "builder" } });
      try { await hooks["tool.execute.before"]({ tool: "bash", sessionID: "s" }, { args: { command: "git push" } }); }
      catch (error) { blocked = error.message; }
      console.log(JSON.stringify({ config, blocked }));
    `;
    const result = Bun.spawnSync(["bun", "-e", script], {
      env: { PATH: process.env.PATH ?? "", HOME: home, XDG_CONFIG_HOME: path.join(home, ".config") },
      cwd: dir,
    });
    expect(result.stderr.toString()).toBe("");
    const { config, blocked } = JSON.parse(result.stdout.toString()) as {
      config: { default_agent?: string; agent: Record<string, Record<string, unknown>> };
      blocked: string;
    };
    expect(config.default_agent).toBe("lead");
    expect(config.agent.reviewer).toEqual({ mode: "subagent", model: "anthropic/claude-opus-5-5", variant: "high" });
    expect(config.agent.scout).toEqual({ mode: "subagent", model: "anthropic/claude-sonnet-5-5", variant: "high", steps: 9 });
    expect(config.agent.lead!.prompt).toBe("x\nReview policy: never\ny");
    expect(blocked).toContain('helpers may not run "git push"');
  });
});

describe("embedHarness", () => {
  test("keeps what the plugin needs: profiles, agents with mode and shell rules, commands", () => {
    const data = embedHarness(resolvedFixture());
    expect(Object.keys(data)).toEqual(["name", "version", "defaultAgent", "defaultProfile", "profiles", "agents", "commands"]);
    expect(data.commands).toEqual([
      { id: "plan", agent: "lead", description: "Plan a piece of work with you" },
      { id: "review", agent: "reviewer", description: "Independent review of your changes" },
    ]);
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
    const builder = data.agents.find((agent) => agent.id === "builder")!;
    expect(builder.mode).toBe("subagent");
    expect(builder.shell.at(0)).toEqual({ resource: "git add *", effect: "deny" });
    expect(builder.shell.at(-1)).toEqual({ resource: "gh *", effect: "deny" });
    expect(data.agents.find((agent) => agent.id === "scout")!.shell.slice(0, 2)).toEqual([
      { resource: "*", effect: "deny" },
      { resource: "git log *", effect: "allow" },
    ]);
  });

  test("from src/: lead and three helpers, and the shell guard checks each helper with its own rules", async () => {
    const data = embedHarness(resolveHarness(await load(root)));
    const helpers = data.agents.filter((agent) => agent.mode === "subagent").map((agent) => agent.id);
    expect(data.agents.map((agent) => agent.id)).toEqual(["lead", ...helpers]);
    expect(helpers).toEqual(["scout", "builder", "reviewer"]);
    for (const helper of helpers) {
      expect(checkShellCommand(data, helper, "git push origin main", "linux")?.part).toBe("git push origin main");
    }
    expect(checkShellCommand(data, "lead", "git push origin main", "linux")).toBeUndefined();
    expect(checkShellCommand(data, "scout", "git log --oneline -5", "linux")).toBeUndefined();
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
