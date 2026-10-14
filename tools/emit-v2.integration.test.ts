// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

// Opt-in check that emitV2 output loads in a real opencode 2 (V2_VERSION). Runs only when
// ECMWF_MULTI_AGENTS_INTEGRATION=1; the binary comes from OPENCODE_V2_BIN (default opencode2).
//
// The test writes the output into the config directory of a fresh sandbox (tools/sandbox.sh),
// starts `opencode serve` on a free local port and reads agents, commands and skills back
// through the HTTP API. No model is called. Project config discovery is switched off so the
// server never reads .opencode, .claude or .agents directories above the sandbox.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { emitV2, v2Permissions, V2_VERSION } from "./emit-v2.ts";
import type { ResolvedHarness } from "./types.ts";

const enabled = process.env.ECMWF_MULTI_AGENTS_INTEGRATION === "1";
const bin = process.env.OPENCODE_V2_BIN ?? "opencode2";
const sandbox = path.resolve(import.meta.dir, "sandbox.sh");

const harness: ResolvedHarness = {
  name: "ecmwf-multi-agents",
  version: "0.1.0",
  defaultAgent: "lead",
  defaultProfile: "default",
  workDir: ".ecmwf-multi-agents",
  marker: "# managed by ecmwf-multi-agents",
  agents: [
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
        { action: "delegate", resource: "builder", effect: "allow" },
        { action: "delegate", resource: "reviewer", effect: "allow" },
        { action: "shell", resource: "git push *", effect: "ask" },
        { action: "shell", resource: "gh pr merge *", effect: "ask" },
      ],
    },
    {
      id: "scout",
      mode: "subagent",
      description: "Read-only lookups and investigations in code, docs or the web. Long findings go to a notes file.",
      prompt: "You are scout.",
      steps: 30,
      model: "anthropic/claude-sonnet-5-5",
      variant: "medium",
      permissions: [
        { action: "edit", resource: "*", effect: "deny" },
        { action: "edit", resource: ".ecmwf-multi-agents/notes/*", effect: "allow" },
        { action: "edit", resource: "*/.ecmwf-multi-agents/notes/*", effect: "allow" },
        { action: "shell", resource: "*", effect: "deny" },
        { action: "shell", resource: "git log *", effect: "allow" },
        { action: "shell", resource: "ls *", effect: "allow" },
        { action: "delegate", resource: "*", effect: "deny" },
        { action: "question", resource: "*", effect: "deny" },
        { action: "todo", resource: "*", effect: "deny" },
        { action: "skill", resource: "ecmwf-multi-agents-*", effect: "deny" },
      ],
    },
    // No model of its own, so it runs on the session model.
    {
      id: "builder",
      mode: "subagent",
      description: "Makes one clearly specified change, runs its checks and reports.",
      prompt: "You are builder.",
      steps: 60,
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
  ],
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

interface ApiRule {
  action: string;
  resource: string;
  effect: string;
}
interface ApiAgent {
  id: string;
  mode: string;
  hidden: boolean;
  description?: string;
  system?: string;
  color?: string;
  steps?: number;
  model?: { id: string; providerID: string; variant?: string };
  permissions: ApiRule[];
}
interface ApiCommand {
  name: string;
  description?: string;
}
interface ApiSkill {
  id: string;
  name: string;
  description?: string;
  autoinvoke?: boolean;
  content: string;
}

async function within<T>(ms: number, what: string, attempt: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await attempt().catch(() => undefined);
    if (value !== undefined) return value;
    await Bun.sleep(250);
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe.skipIf(!enabled)(`emitV2 output in opencode ${V2_VERSION}`, () => {
  let dir = "";
  let project = "";
  let server: { kill: (signal?: NodeJS.Signals) => void; exited: Promise<number> } | undefined;
  let base = "";
  let auth = "";
  let output = "";

  const get = async <T>(route: string): Promise<T> => {
    const url = new URL(route, base);
    url.searchParams.set("location[directory]", project);
    const response = await fetch(url, { headers: { authorization: auth } });
    if (!response.ok) throw new Error(`GET ${route}: HTTP ${response.status}`);
    return ((await response.json()) as { data: T }).data;
  };

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "ecmwf-multi-agents-v2-"));
    project = path.join(dir, "project");
    mkdirSync(project);
    const config = path.join(dir, "home", ".config", "opencode");
    for (const item of emitV2(harness)) {
      const target = path.join(config, item.path);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, item.content);
    }

    const version = Bun.spawnSync([sandbox, dir, bin, "--version"], { cwd: project });
    expect(version.stdout.toString()).toContain(V2_VERSION);

    const password = randomBytes(16).toString("hex");
    auth = `Basic ${btoa(`opencode:${password}`)}`;
    const proc = Bun.spawn([sandbox, dir, bin, "serve", "--hostname", "127.0.0.1", "--port", "0"], {
      cwd: project,
      env: {
        ...process.env,
        OPENCODE_PASSWORD: password,
        OPENCODE_DISABLE_PROJECT_CONFIG: "1",
        OPENCODE_DISABLE_MODELS_FETCH: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    server = proc;
    // Keep draining both pipes so the server never blocks on a full one.
    const drain = async (stream: ReadableStream<Uint8Array>, sink: (text: string) => void) => {
      const decoder = new TextDecoder();
      for await (const chunk of stream) sink(decoder.decode(chunk));
    };
    let errors = "";
    void drain(proc.stdout, (text) => (output += text));
    void drain(proc.stderr, (text) => (errors += text));
    type Started = { type: "listening"; url: string } | { type: "exited"; code: number };
    const started = await within<Started>(30_000, "the server address", async () => {
      if (proc.exitCode !== null) return { type: "exited", code: proc.exitCode };
      const url = /server listening on (http:\/\/\S+)/.exec(output)?.[1];
      return url === undefined ? undefined : { type: "listening", url };
    }).catch((error: Error) => {
      throw new Error(`${error.message}\n${errors}`);
    });
    if (started.type === "exited") throw new Error(`opencode serve exited with ${started.code}\n${errors}`);
    base = started.url;
    // Plugins, including the one that reads agent files, activate after the server starts listening.
    await within(60_000, "the generated agents", async () => {
      const agents = await get<ApiAgent[]>("/api/agent");
      return agents.some((agent) => agent.id === "lead") ? agents : undefined;
    });
  }, 120_000);

  afterAll(async () => {
    if (server) {
      server.kill();
      const exited = await Promise.race([server.exited.then(() => true), Bun.sleep(5_000).then(() => false)]);
      if (!exited) server.kill("SIGKILL");
    }
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("every generated agent loads; none is silently dropped", async () => {
    const ids = (await get<ApiAgent[]>("/api/agent")).map((agent) => agent.id);
    for (const agent of harness.agents) expect(ids).toContain(agent.id);
  });

  test("description, mode, system prompt, steps and color resolve as written", async () => {
    const agents = await get<ApiAgent[]>("/api/agent");
    for (const expected of harness.agents) {
      const agent = agents.find((item) => item.id === expected.id)!;
      expect(agent.mode).toBe(expected.mode);
      expect(agent.hidden).toBe(false);
      expect(agent.description).toBe(expected.description);
      expect(agent.system).toBe(expected.prompt.trim());
      expect(agent.steps).toBe(expected.steps);
      expect(agent.color).toBe(expected.color);
    }
  });

  test("models resolve with their variants; agents without a model use the session model", async () => {
    const agents = await get<ApiAgent[]>("/api/agent");
    const model = (id: string) => agents.find((agent) => agent.id === id)?.model;
    expect(model("lead")).toEqual({ id: "claude-opus-5-5", providerID: "anthropic", variant: "xhigh" });
    expect(model("scout")).toEqual({ id: "claude-sonnet-5-5", providerID: "anthropic", variant: "medium" });
    expect(model("reviewer")).toEqual({ id: "gpt-6.1-sol", providerID: "github-copilot", variant: "medium" });
    expect(model("builder")).toBeUndefined();
  });

  /**
   * What opencode appends after every agent's own rules: its browser plugin hides the browser
   * tools until a desktop browser attaches (plugin-browser/src/connection.ts:25-28 at v2.0.28).
   */
  const TRAILING = [{ action: "browser", resource: "*", effect: "deny" }];
  /** An agent's rules without what opencode appends after them. */
  const ownRules = (agents: ApiAgent[], id: string) => {
    const rules = agents.find((agent) => agent.id === id)!.permissions;
    expect(rules.slice(rules.length - TRAILING.length)).toEqual(TRAILING);
    return rules.slice(0, rules.length - TRAILING.length);
  };

  test("agent rules follow the built-in defaults in order, with dropped actions absent", async () => {
    const agents = await get<ApiAgent[]>("/api/agent");
    for (const expected of harness.agents) {
      const rules = ownRules(agents, expected.id);
      const mapped = v2Permissions(expected.permissions).rules;
      expect(rules[0]).toEqual({ action: "*", resource: "*", effect: "allow" });
      expect(rules.slice(rules.length - mapped.length)).toEqual(mapped);
      expect(rules.some((rule) => rule.action === "todo" || rule.action === "todowrite")).toBe(false);
    }
  });

  test("rules use opencode 2's action names (written out here, independent of the emitter)", async () => {
    const agents = await get<ApiAgent[]>("/api/agent");
    const tail = (id: string, count: number) => {
      const rules = ownRules(agents, id);
      return rules.slice(rules.length - count).map((rule) => `${rule.action} ${rule.resource} ${rule.effect}`);
    };
    expect(tail("lead", 7)).toEqual([
      "question * allow",
      "subagent * deny",
      "subagent scout allow",
      "subagent builder allow",
      "subagent reviewer allow",
      "shell git push * ask",
      "shell gh pr merge * ask",
    ]);
    expect(tail("scout", 9)).toEqual([
      "edit * deny",
      "edit .ecmwf-multi-agents/notes/* allow",
      "edit */.ecmwf-multi-agents/notes/* allow",
      "shell * deny",
      "shell git log * allow",
      "shell ls * allow",
      "subagent * deny",
      "question * deny",
      "skill ecmwf-multi-agents-* deny",
    ]);
    expect(tail("builder", 5)).toEqual([
      "shell git push * deny",
      "shell git commit * deny",
      "shell gh * deny",
      "subagent * deny",
      "question * deny",
    ]);
  });

  test("commands load under their ids with their descriptions", async () => {
    const commands = await get<ApiCommand[]>("/api/command");
    for (const expected of harness.commands) {
      expect(commands.find((command) => command.name === expected.id)?.description).toBe(expected.description);
    }
  });

  test("skills load by id; hidden skills are marked autoinvoke false", async () => {
    const skills = await get<ApiSkill[]>("/api/skill");
    for (const expected of harness.skills) {
      const skill = skills.find((item) => item.id === expected.id);
      expect(skill?.name).toBe(expected.id);
      expect(skill?.description).toBe(expected.description);
      expect(skill?.content.trim()).toBe(expected.body.trim());
      if (expected.hidden) expect(skill?.autoinvoke).toBe(false);
      else expect(skill?.autoinvoke).toBeUndefined();
    }
  });
});
