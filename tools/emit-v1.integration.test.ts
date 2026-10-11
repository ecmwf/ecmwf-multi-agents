// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

// Opt-in check that emitV1 output loads in real opencode 1.x binaries. Runs only when
// ECMWF_MULTI_AGENTS_INTEGRATION=1; binaries come from OPENCODE_V1_BINS (space-separated,
// default "opencode").
//
// For each binary the test writes the output into the config directory of a fresh sandbox
// (tools/sandbox.sh, under the system temporary directory) and reads it back with
// `opencode debug agent`, `debug config` and `debug skill`. `debug agent --tool` runs a tool
// call through an agent's permission rules: a denied call fails before the tool runs. No model
// is called. Project config, external skills and Claude Code files are switched off so nothing
// above the sandbox is read.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { emitV1, v1Color, v1Permission } from "./emit-v1.ts";
import type { ResolvedAgent, ResolvedHarness, Rule } from "./types.ts";

const enabled = process.env.ECMWF_MULTI_AGENTS_INTEGRATION === "1";
const bins = (process.env.OPENCODE_V1_BINS ?? "opencode").split(/\s+/).filter((bin) => bin !== "");
const sandbox = path.resolve(import.meta.dir, "sandbox.sh");

const ISOLATION = {
  OPENCODE_DISABLE_PROJECT_CONFIG: "1",
  OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
  OPENCODE_DISABLE_CLAUDE_CODE: "1",
  OPENCODE_DISABLE_MODELS_FETCH: "1",
};

const readOnlyShell: Rule[] = ["git log *", "git status *", "ls *"].map((resource) => ({
  action: "shell",
  resource,
  effect: "allow",
}));

const scoutRules: Rule[] = [
  { action: "edit", resource: "*", effect: "deny" },
  { action: "shell", resource: "*", effect: "deny" },
  ...readOnlyShell,
  { action: "delegate", resource: "*", effect: "deny" },
  { action: "question", resource: "*", effect: "deny" },
  { action: "todo", resource: "*", effect: "deny" },
  { action: "skill", resource: "ecmwf-multi-agents-*", effect: "deny" },
];

const agents: ResolvedAgent[] = [
  {
    id: "lead",
    mode: "primary",
    description: "Talks to you, plans, hands work to helpers and checks the results. Start here.",
    prompt: "You are lead.\n\nReview policy: auto",
    color: "#0b5394",
    model: "anthropic/claude-opus-5-5",
    variant: "xhigh",
    permissions: [
      { action: "question", resource: "*", effect: "allow" },
      { action: "delegate", resource: "*", effect: "deny" },
      { action: "delegate", resource: "scout", effect: "allow" },
      { action: "delegate", resource: "scout-deep", effect: "allow" },
      { action: "delegate", resource: "builder", effect: "allow" },
      { action: "delegate", resource: "reviewer", effect: "allow" },
      { action: "shell", resource: "git push *", effect: "ask" },
      { action: "shell", resource: "gh pr merge *", effect: "ask" },
    ],
  },
  {
    id: "scout",
    mode: "subagent",
    description: "Quick read-only lookup in code, docs or the web.",
    prompt: "You are scout.",
    steps: 15,
    model: "anthropic/claude-sonnet-5-5",
    variant: "medium",
    permissions: scoutRules,
  },
  {
    id: "scout-deep",
    mode: "subagent",
    description: "Longer read-only investigation. Writes long findings to a notes file.",
    prompt: "You are scout.\n\nDeep addendum.",
    steps: 40,
    permissions: [
      ...scoutRules,
      { action: "edit", resource: "*", effect: "deny" },
      { action: "edit", resource: ".ecmwf-multi-agents/notes/*", effect: "allow" },
    ],
  },
  {
    id: "builder",
    mode: "subagent",
    description: "Makes one clearly specified change, runs its checks and reports.",
    prompt: "You are builder.",
    steps: 40,
    model: "anthropic/claude-sonnet-5-5",
    variant: "high",
    permissions: [
      { action: "shell", resource: "git push *", effect: "deny" },
      { action: "shell", resource: "git commit *", effect: "deny" },
      { action: "shell", resource: "gh *", effect: "deny" },
      { action: "delegate", resource: "*", effect: "deny" },
      { action: "question", resource: "*", effect: "deny" },
    ],
  },
  {
    id: "reviewer",
    mode: "subagent",
    description: "Independent review of a plan or a change.",
    prompt: "You are reviewer.",
    steps: 30,
    model: "github-copilot/gpt-6.1-sol",
    variant: "medium",
    permissions: [
      { action: "edit", resource: "*", effect: "deny" },
      { action: "shell", resource: "gh *", effect: "deny" },
      { action: "shell", resource: "gh pr view *", effect: "allow" },
      { action: "webfetch", resource: "*", effect: "allow" },
      { action: "external_directory", resource: "/tmp/reviews/*", effect: "ask" },
    ],
  },
];

const harness: ResolvedHarness = {
  name: "ecmwf-multi-agents",
  version: "0.1.0",
  defaultAgent: "lead",
  defaultProfile: "default",
  workDir: ".ecmwf-multi-agents",
  marker: "# managed by ecmwf-multi-agents",
  agents,
  commands: [
    { id: "plan", description: "Plan a piece of work with you", agent: "lead", subtask: false, template: "Plan: $ARGUMENTS" },
    { id: "review", description: "Independent review of your changes", agent: "reviewer", subtask: true, template: "Review $ARGUMENTS" },
    { id: "status", description: "Show progress on the current plan", agent: "scout", subtask: false, template: "Status." },
  ],
  skills: [
    { id: "ecmwf-multi-agents-plan", description: "Plan file format and rules.", body: "# Plan\n\nRules.", hidden: true },
    { id: "ecmwf-multi-agents-guide", description: "User guide to the harness.", body: "# Guide", hidden: false },
  ],
  profiles: [],
};

interface DebugRule {
  permission: string;
  pattern: string;
  action: string;
}
interface DebugAgent {
  name: string;
  description?: string;
  mode: string;
  native?: boolean;
  model?: { providerID: string; modelID: string };
  variant?: string;
  steps?: number;
  color?: string;
  prompt?: string;
  options: Record<string, unknown>;
  permission: DebugRule[];
  tools: Record<string, boolean>;
}
interface DebugSkill {
  name: string;
  description?: string | null;
  content: string;
}

/** The ordered rules opencode builds from an emitted permission map (permission/index.ts fromConfig). */
function expectedRules(rules: readonly Rule[]): DebugRule[] {
  const out: DebugRule[] = [];
  for (const [permission, value] of Object.entries(v1Permission(rules))) {
    if (typeof value === "string") out.push({ permission, pattern: "*", action: value });
    else for (const [pattern, action] of Object.entries(value as Record<string, string>)) out.push({ permission, pattern, action });
  }
  return out;
}

for (const bin of bins) {
  describe.skipIf(!enabled)(`emitV1 output in ${bin}`, () => {
    let dir = "";
    let project = "";
    let version = "";
    const loaded = new Map<string, DebugAgent>();
    let config: { command?: Record<string, Record<string, unknown>> } = {};
    let skills: DebugSkill[] = [];

    const run = async (args: string[]): Promise<{ code: number; stdout: string; stderr: string }> => {
      const proc = Bun.spawn([sandbox, dir, bin, ...args], {
        cwd: project,
        env: { ...process.env, ...ISOLATION },
        stdout: "pipe",
        stderr: "pipe",
      });
      const timer = setTimeout(() => proc.kill("SIGKILL"), 90_000);
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      clearTimeout(timer);
      return { code, stdout, stderr };
    };

    const json = async <T>(args: string[]): Promise<T> => {
      const result = await run(args);
      if (result.code !== 0) throw new Error(`${bin} ${args.join(" ")} exited ${result.code}\n${result.stderr}${result.stdout}`);
      return JSON.parse(result.stdout) as T;
    };

    /** Run one tool call through an agent's rules; "denied" when a rule stops it. */
    const tool = async (agent: string, name: string, params: Record<string, unknown>): Promise<"denied" | "allowed"> => {
      const result = await run(["debug", "agent", agent, "--tool", name, "--params", JSON.stringify(params)]);
      return `${result.stdout}${result.stderr}`.includes("prevents you from using this specific tool call") ? "denied" : "allowed";
    };

    beforeAll(async () => {
      dir = mkdtempSync(path.join(tmpdir(), "ecmwf-multi-agents-v1-"));
      project = path.join(dir, "project");
      mkdirSync(project);
      const configDir = path.join(dir, "home", ".config", "opencode");
      for (const item of emitV1(harness)) {
        const target = path.join(configDir, item.path);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, item.content);
      }
      version = (await run(["--version"])).stdout.trim();
      for (const agent of agents) loaded.set(agent.id, await json<DebugAgent>(["debug", "agent", agent.id]));
      config = await json(["debug", "config"]);
      skills = await json<DebugSkill[]>(["debug", "skill"]);
    }, 300_000);

    afterAll(() => {
      if (dir) rmSync(dir, { recursive: true, force: true });
    });

    test("the binary is opencode 1.x", () => {
      expect(version).toMatch(/^1\.\d+\.\d+$/);
    });

    test("description, mode, prompt, model, variant, steps and color resolve as written", () => {
      for (const expected of agents) {
        const agent = loaded.get(expected.id)!;
        expect(agent.name).toBe(expected.id);
        expect(agent.native).toBe(false);
        expect(agent.description).toBe(expected.description);
        expect(agent.mode).toBe(expected.mode);
        expect(agent.prompt).toBe(expected.prompt.trim());
        expect(agent.variant).toBe(expected.variant);
        expect(agent.steps).toBe(expected.steps);
        expect(agent.color).toBe(v1Color(expected.color));
        // Unknown frontmatter keys would land here and reach the model provider.
        expect(agent.options).toEqual({});
        if (expected.model === undefined) expect(agent.model).toBeUndefined();
        else {
          const [providerID, ...rest] = expected.model.split("/");
          expect(agent.model).toEqual({ providerID: providerID!, modelID: rest.join("/") });
        }
      }
    });

    test("agent rules follow the defaults in their emitted order", () => {
      for (const expected of agents) {
        const rules = loaded.get(expected.id)!.permission;
        const ours = expectedRules(expected.permissions);
        // opencode appends one external_directory allow for its tool-output folder after them.
        const tail = rules.at(-1)!;
        expect(tail.permission).toBe("external_directory");
        expect(tail.action).toBe("allow");
        expect(rules.slice(rules.length - 1 - ours.length, -1)).toEqual(ours);
        expect(rules[0]).toEqual({ permission: "*", pattern: "*", action: "allow" });
      }
    });

    test("tools disabled by a final '*' deny are removed; others stay", () => {
      const tools = (id: string) => loaded.get(id)!.tools;
      expect(tools("lead")).toMatchObject({ question: true, task: true, bash: true, edit: true });
      expect(tools("scout")).toMatchObject({ question: false, task: false, todowrite: false, edit: false, write: false, bash: true });
      expect(tools("scout-deep")).toMatchObject({ edit: true, write: true, task: false });
      expect(tools("builder")).toMatchObject({ question: false, task: false, edit: true, bash: true });
      // GPT models get apply_patch instead of edit and write; edit rules cover it too.
      expect(tools("reviewer")).toMatchObject({ apply_patch: false, webfetch: true });
      expect("edit" in tools("reviewer")).toBe(false);
    });

    test("'X *' rules also stop a bare 'X'; read-only commands still run", async () => {
      expect(await tool("builder", "bash", { command: "git push", description: "probe" })).toBe("denied");
      expect(await tool("builder", "bash", { command: "git push origin main", description: "probe" })).toBe("denied");
      expect(await tool("scout", "bash", { command: "rm -rf build", description: "probe" })).toBe("denied");
      expect(await tool("scout", "bash", { command: "ls", description: "probe" })).toBe("allowed");
    }, 300_000);

    test("lead may delegate to the helpers only", async () => {
      expect(await tool("lead", "task", { description: "d", prompt: "p", subagent_type: "general" })).toBe("denied");
      // Past the permission check the debug runner has no session loop, so the call stops there.
      expect(await tool("lead", "task", { description: "d", prompt: "p", subagent_type: "scout" })).toBe("allowed");
    }, 300_000);

    test("commands load with description, agent and subtask", () => {
      const commands = config.command ?? {};
      expect(commands.plan).toEqual({ description: "Plan a piece of work with you", agent: "lead", template: "Plan: $ARGUMENTS" });
      expect(commands.review).toEqual({
        description: "Independent review of your changes",
        agent: "reviewer",
        subtask: true,
        template: "Review $ARGUMENTS",
      });
      expect(commands.status).toEqual({
        description: "Show progress on the current plan",
        agent: "scout",
        subtask: false,
        template: "Status.",
      });
    });

    test("skills load by name; hidden skills have no description", () => {
      for (const expected of harness.skills) {
        const skill = skills.find((item) => item.name === expected.id);
        expect(skill?.content.trim()).toBe(expected.body.trim());
        if (expected.hidden) expect(skill?.description ?? undefined).toBeUndefined();
        else expect(skill?.description).toBe(expected.description);
      }
    });
  });
}
