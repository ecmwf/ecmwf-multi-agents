// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  NO_TEXT,
  SUBAGENT_PREFIX,
  applyAgent,
  childOutcome,
  commandDefinition,
  expandHome,
  expandPermissions,
  fillTemplate,
  parseModel,
  registerHarness,
  skillInfo,
  subagentReport,
} from "./register.ts";
import { v2Reporter } from "./report.ts";
import { embeddedFixture } from "./testing.ts";
import type { V2AgentEditor, V2AgentInfo, V2CommandDefinition, V2Context, V2SkillInfo } from "./types.ts";

const harness = embeddedFixture();

describe("agents as opencode's loader reads their files", () => {
  test("model references: provider/model and provider/model#variant, split as opencode splits them", () => {
    expect(parseModel("anthropic/claude-opus-5-5")).toEqual({ providerID: "anthropic", id: "claude-opus-5-5" });
    expect(parseModel("anthropic/claude-opus-5-5#xhigh")).toEqual({ providerID: "anthropic", id: "claude-opus-5-5", variant: "xhigh" });
    expect(parseModel("openrouter/meta/llama#low")).toEqual({ providerID: "openrouter", id: "meta/llama", variant: "low" });
    for (const bad of ["no-slash", "/model", "p/", "p/m#", "p/m#a#b", "p#x/m"]) expect(parseModel(bad)).toBeUndefined();
  });

  test("~ and $HOME are expanded in path rules only, as for agent files", () => {
    expect(expandHome("~", "/home/u")).toBe("/home/u");
    expect(expandHome("$HOME", "/home/u")).toBe("/home/u");
    expect(expandHome("~/notes/*", "/home/u")).toBe("/home/u/notes/*");
    expect(expandHome("$HOME/notes/*", "/home/u")).toBe("/home/u/notes/*");
    expect(expandHome("$HOME\\notes", "C:\\Users\\u")).toBe("C:\\Users\\u\\notes");
    expect(expandHome("~user/x", "/home/u")).toBe("~user/x");
    expect(expandHome("*/~/x", "/home/u")).toBe("*/~/x");
    const rules = [
      { action: "edit", resource: "~/a", effect: "allow" },
      { action: "read", resource: "$HOME/b", effect: "deny" },
      { action: "external_directory", resource: "~", effect: "ask" },
      { action: "shell", resource: "ls ~/c", effect: "allow" },
      { action: "shell", resource: "$HOME/d", effect: "allow" },
    ];
    expect(expandPermissions(rules, "/home/u").map((rule) => rule.resource)).toEqual(["/home/u/a", "/home/u/b", "/home/u", "ls ~/c", "$HOME/d"]);
    expect(rules[0]!.resource).toBe("~/a");
  });

  test("every field of the file lands on the agent; permissions follow opencode's defaults", () => {
    const agent: V2AgentInfo = { id: "scout", mode: "primary", hidden: false, permissions: [{ action: "*", resource: "*", effect: "allow" }] };
    applyAgent(
      agent,
      {
        id: "scout",
        mode: "subagent",
        description: "Looks things up.",
        model: "anthropic/claude-sonnet-5-5#medium",
        steps: 30,
        color: "#123456",
        hidden: true,
        permissions: [{ action: "edit", resource: "~/notes/*", effect: "allow" }],
        system: "You are scout.",
      },
      "/home/u",
    );
    expect(agent).toEqual({
      id: "scout",
      mode: "subagent",
      description: "Looks things up.",
      model: { providerID: "anthropic", id: "claude-sonnet-5-5", variant: "medium" },
      steps: 30,
      color: "#123456",
      hidden: true,
      system: "You are scout.",
      permissions: [
        { action: "*", resource: "*", effect: "allow" },
        { action: "edit", resource: "/home/u/notes/*", effect: "allow" },
      ],
    });
  });

  test("fields the file leaves out stay as they are", () => {
    const agent: V2AgentInfo = { id: "lead", mode: "primary", hidden: false, steps: 5, permissions: [] };
    applyAgent(agent, { id: "lead", mode: "primary" }, "/home/u");
    expect(agent).toEqual({ id: "lead", mode: "primary", hidden: false, steps: 5, permissions: [] });
  });
});

describe("command arguments, as opencode fills a file command's", () => {
  test("$ARGUMENTS takes the whole input", () => {
    expect(fillTemplate("Review: $ARGUMENTS", "main --strict")).toBe("Review: main --strict");
    expect(fillTemplate("Target: $ARGUMENTS\n\nMore.", "")).toBe("Target: \n\nMore.");
  });

  test("$1 and $2 take words, the last placeholder takes the rest, quotes group words", () => {
    expect(fillTemplate("A=$1 B=$2", 'one "two three" four')).toBe("A=one B=two three four");
    expect(fillTemplate("A=$1 B=$2", "one")).toBe("A=one B=");
    expect(fillTemplate("A=$1", "'x y'")).toBe("A=x y");
  });

  test("a template without placeholders gets the input appended", () => {
    expect(fillTemplate("Show progress.", "plan-a")).toBe("Show progress.\n\nplan-a");
    expect(fillTemplate("Show progress.", "  ")).toBe("Show progress.");
  });
});

describe("skills", () => {
  test("the path is the generated file next to the plugin folder, the content as embedded", () => {
    const skill = skillInfo(harness.skills[0]!, "/x/dist/opencode-v2/plugins/ecmwf-multi-agents");
    expect(skill).toEqual({
      id: "ecmwf-multi-agents-plan",
      name: "ecmwf-multi-agents-plan",
      description: "Plan file format and rules.",
      autoinvoke: false,
      path: "/x/dist/opencode-v2/skills/ecmwf-multi-agents-plan/SKILL.md",
      content: "\n# Plan\n\nRules.\n",
    });
  });
});

/** A session API that records calls; `messages` are what a child's context returns. */
function sessionHost(messages: unknown[] = []) {
  const calls: Array<[string, Record<string, unknown>]> = [];
  let waited: () => void = () => {};
  const done = new Promise<void>((resolve) => (waited = resolve));
  const record = (name: string) => async (input: Record<string, unknown>) => {
    calls.push([name, input]);
    return undefined;
  };
  const agents: Record<string, V2AgentInfo> = {
    lead: { id: "lead", mode: "primary", model: { id: "big", providerID: "p", variant: "xhigh" } },
    reviewer: { id: "reviewer", mode: "subagent", model: { id: "gpt", providerID: "q" } },
  };
  const ctx = {
    agent: {
      transform: async () => ({ dispose: async () => {} }),
      get: async ({ agentID }: { agentID: string }) => ({ data: agents[agentID] }),
    },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => ({ id: sessionID, agent: "build", model: { id: "m", providerID: "s" } }),
      create: async (input: Record<string, unknown>) => {
        calls.push(["create", input]);
        return { id: "child1", ...input };
      },
      switchAgent: record("switchAgent"),
      switchModel: record("switchModel"),
      prompt: record("prompt"),
      wait: async (input: Record<string, unknown>) => {
        calls.push(["wait", input]);
      },
      context: async () => messages,
      synthetic: async (input: Record<string, unknown>) => {
        calls.push(["synthetic", input]);
        waited();
      },
    },
  } as unknown as V2Context;
  return { ctx, calls, done };
}

const reporter = v2Reporter("ecmwf-multi-agents", () => {});

describe("commands", () => {
  const plan = harness.commands.find((command) => command.name === "plan")!;
  const review = harness.commands.find((command) => command.name === "review")!;

  test("a normal command switches the session to its agent and model, then prompts there", async () => {
    const { ctx, calls } = sessionHost();
    const definition = commandDefinition(ctx, harness, plan, { reporter });
    expect(definition.name).toBe("plan");
    expect(definition.description).toBe("Plan a piece of work with you");
    await definition.execute({ sessionID: "s1", prompt: { text: "a new feature", files: [] }, delivery: "queue" });
    expect(calls).toEqual([
      ["switchAgent", { sessionID: "s1", agent: "lead" }],
      ["switchModel", { sessionID: "s1", model: { id: "big", providerID: "p", variant: "xhigh" } }],
      ["prompt", { text: "Plan: a new feature", files: [], sessionID: "s1", delivery: "queue" }],
    ]);
  });

  test("a subagent command runs its helper in a child and reports back the way opencode does", async () => {
    const messages = [
      { type: "user", content: [] },
      { type: "assistant", content: [{ type: "text", text: "VERDICT: APPROVE" }], time: { created: 1, completed: 2 } },
    ];
    const { ctx, calls, done } = sessionHost(messages);
    await commandDefinition(ctx, harness, review, { reporter }).execute({ sessionID: "s1", prompt: { text: "main" }, delivery: "steer" });
    expect(calls.slice(0, 2)).toEqual([
      ["create", { parentID: "s1", title: "Independent review of your changes", agent: "reviewer", model: { id: "gpt", providerID: "q" } }],
      ["prompt", { text: `${SUBAGENT_PREFIX}\nReview main`, sessionID: "child1" }],
    ]);
    await done;
    expect(calls.slice(2)).toEqual([
      ["wait", { sessionID: "child1" }],
      [
        "synthetic",
        {
          sessionID: "s1",
          description: "Independent review of your changes",
          text: '<subagent sessionID="child1" state="completed" description="Independent review of your changes">\nVERDICT: APPROVE\n</subagent>',
          metadata: { source: "subagent", childID: "child1", agent: "reviewer", state: "completed" },
          delivery: "queue",
        },
      ],
    ]);
  });

  test("the outcome of a child: its last answer, a failure, or a cancelled run", () => {
    const answer = (text: string, extra: Record<string, unknown> = {}) => ({ type: "assistant", content: [{ type: "text", text }], time: { created: 1, completed: 2 }, ...extra });
    expect(childOutcome([answer("one"), { type: "user" }, answer("two")])).toEqual({ state: "completed", text: "two" });
    expect(childOutcome([answer("")])).toEqual({ state: "completed", text: NO_TEXT });
    expect(childOutcome([])).toEqual({ state: "completed", text: NO_TEXT });
    expect(childOutcome([answer("x", { error: { type: "provider", message: "rate limited" } })])).toEqual({ state: "error", text: "rate limited" });
    expect(childOutcome([answer("half", { time: { created: 1 } })])).toEqual({ state: "cancelled", text: "Subagent cancelled" });
    expect(subagentReport("c", "error", "d", "t")).toBe('<subagent sessionID="c" state="error" description="d">\nt\n</subagent>');
  });
});

describe("registerHarness", () => {
  function editors() {
    const agents = new Map<string, V2AgentInfo>();
    let selected: string | undefined;
    const skills: V2SkillInfo[] = [];
    const commands: V2CommandDefinition[] = [];
    const agentEditor: V2AgentEditor = {
      list: () => [...agents.values()],
      get: (id) => agents.get(id),
      default: (id) => {
        selected = id;
      },
      update: (id, change) => {
        const agent = agents.get(id) ?? { id, mode: "primary", hidden: false, permissions: [] };
        agents.set(id, agent);
        change(agent);
      },
    };
    const ctx = {
      agent: { transform: async (callback: (editor: V2AgentEditor) => void) => (callback(agentEditor), { dispose: async () => {} }) },
      skill: { transform: async (callback: (editor: { add: (skill: V2SkillInfo) => void }) => void) => (callback({ add: (skill) => skills.push(skill) }), { dispose: async () => {} }) },
      command: {
        transform: async (callback: (editor: { add: (command: V2CommandDefinition) => void }) => void) => (callback({ add: (command) => commands.push(command) }), { dispose: async () => {} }),
      },
    } as unknown as V2Context;
    return { ctx, agents, skills, commands, selected: () => selected };
  }

  test("creates every agent, the default agent, every skill and every command", async () => {
    const host = editors();
    await registerHarness(host.ctx, harness, { home: "/home/u", pluginDir: "/p/plugins/ecmwf-multi-agents", defaultAgent: true, reporter });
    expect([...host.agents.keys()]).toEqual(["lead", "scout", "builder", "reviewer"]);
    expect(host.agents.get("reviewer")).toMatchObject({ mode: "subagent", steps: 30, system: "You are reviewer.", model: { providerID: "github-copilot", id: "gpt-6.1-sol", variant: "medium" } });
    expect(host.selected()).toBe("lead");
    expect(host.skills.map((skill) => skill.path)).toEqual(["/p/skills/ecmwf-multi-agents-plan/SKILL.md"]);
    expect(host.commands.map((command) => command.name)).toEqual(["plan", "review"]);
  });

  test("default_agent false leaves the default alone", async () => {
    const host = editors();
    await registerHarness(host.ctx, harness, { home: "/home/u", pluginDir: "/p", defaultAgent: false, reporter });
    expect(host.selected()).toBeUndefined();
  });
});
