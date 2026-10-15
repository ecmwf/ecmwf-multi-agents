// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { YAML } from "bun";
import { emitV2, V2_ACTIONS, v2Model, v2Permissions } from "./emit-v2.ts";
import { ACTIONS, type OutputFile, type ResolvedAgent, type ResolvedHarness } from "./types.ts";

const MARKER = "# managed by ecmwf-multi-agents";

function fixture(): ResolvedHarness {
  return {
    name: "ecmwf-multi-agents",
    version: "0.1.0",
    defaultAgent: "lead",
    defaultProfile: "default",
    workDir: ".ecmwf-multi-agents",
    marker: MARKER,
    agents: [
      {
        id: "lead",
        mode: "primary",
        description: "Talks to you, plans and checks the results. Start here.",
        prompt: "Lead prompt.\n\nSecond paragraph.\n",
        color: "#0b5394",
        model: "anthropic/claude-opus-5-5",
        variant: "xhigh",
        permissions: [
          { action: "question", resource: "*", effect: "allow" },
          { action: "delegate", resource: "*", effect: "deny" },
          { action: "delegate", resource: "scout", effect: "allow" },
          { action: "delegate", resource: "reviewer", effect: "allow" },
          { action: "shell", resource: "git push *", effect: "ask" },
        ],
      },
      {
        id: "scout",
        mode: "subagent",
        description: "Quick read-only lookup.",
        prompt: "Scout prompt.",
        steps: 15,
        model: "anthropic/claude-sonnet-5-5",
        variant: "medium",
        permissions: [
          { action: "edit", resource: "*", effect: "deny" },
          { action: "edit", resource: ".ecmwf-multi-agents/notes/*", effect: "allow" },
          { action: "shell", resource: "*", effect: "deny" },
          { action: "shell", resource: "git log *", effect: "allow" },
          { action: "delegate", resource: "*", effect: "deny" },
          { action: "question", resource: "*", effect: "deny" },
          { action: "skill", resource: "ecmwf-multi-agents-*", effect: "deny" },
        ],
      },
      {
        id: "builder",
        mode: "subagent",
        description: "Makes one clearly specified change.",
        prompt: "Builder prompt.",
        steps: 40,
        model: "anthropic/claude-sonnet-5-5",
        permissions: [
          { action: "shell", resource: "git commit *", effect: "deny" },
          { action: "read", resource: "*", effect: "allow" },
          { action: "glob", resource: "*", effect: "allow" },
          { action: "grep", resource: "*", effect: "allow" },
          { action: "webfetch", resource: "*", effect: "allow" },
          { action: "websearch", resource: "*", effect: "allow" },
          { action: "external_directory", resource: "~/data/*", effect: "ask" },
        ],
      },
      // No model of its own and no rules: it runs on the session model with the defaults.
      {
        id: "reviewer",
        mode: "subagent",
        description: "Independent review: APPROVE or REJECT.",
        prompt: "Reviewer prompt.\n\nSecond part.",
        steps: 30,
        permissions: [],
      },
    ],
    commands: [
      { id: "plan", description: "Plan a piece of work", agent: "lead", subtask: false, template: "Plan: $ARGUMENTS" },
      { id: "review", description: "Independent review", agent: "reviewer", subtask: true, template: "Review it." },
      { id: "status", description: "Show progress", agent: "scout", subtask: false, template: "Status." },
      { id: "guide", description: "How this works", agent: "build", subtask: false, template: "Guide." },
    ],
    skills: [
      { id: "ecmwf-multi-agents-plan", description: "Plan file format.", body: "# Plan\n\nRules.", hidden: true },
      { id: "visible-skill", description: "A listed skill.", body: "Visible body.", hidden: false },
    ],
    profiles: [],
  };
}

interface Doc {
  comments: string[];
  data: Record<string, unknown>;
  body: string;
}

function parse(content: string): Doc {
  expect(content.startsWith("---\n")).toBe(true);
  const end = content.indexOf("\n---\n", 4);
  expect(end).toBeGreaterThan(0);
  const head = content.slice(4, end);
  const rest = content.slice(end + 5);
  expect(rest.startsWith("\n")).toBe(true);
  return {
    comments: head.split("\n").filter((line) => line.startsWith("#")),
    data: YAML.parse(head) as Record<string, unknown>,
    body: rest.slice(1),
  };
}

function file(files: OutputFile[], path: string): Doc {
  const found = files.find((item) => item.path === path);
  if (!found) throw new Error(`no output at ${path}`);
  return parse(found.content);
}

const withAgent = (change: Partial<ResolvedAgent>): ResolvedHarness => {
  const harness = fixture();
  harness.agents = [{ ...harness.agents[0]!, ...change }];
  harness.commands = [];
  harness.skills = [];
  return harness;
};

describe("emitV2 layout", () => {
  test("writes agents, commands and skills at v2 config-dir paths, sorted by path", () => {
    expect(emitV2(fixture()).map((item) => item.path)).toEqual([
      "agents/builder.md",
      "agents/lead.md",
      "agents/reviewer.md",
      "agents/scout.md",
      "commands/guide.md",
      "commands/plan.md",
      "commands/review.md",
      "commands/status.md",
      "skills/ecmwf-multi-agents-plan/SKILL.md",
      "skills/visible-skill/SKILL.md",
    ]);
  });

  test("every file carries the marker as the first frontmatter line", () => {
    for (const item of emitV2(fixture())) {
      expect(item.content.split("\n").slice(0, 2)).toEqual(["---", MARKER]);
    }
  });

  test("output is deterministic and independent of input order", () => {
    const first = emitV2(fixture());
    const shuffled = fixture();
    shuffled.agents.reverse();
    shuffled.commands.reverse();
    shuffled.skills.reverse();
    expect(emitV2(fixture())).toEqual(first);
    expect(emitV2(shuffled)).toEqual(first);
  });
});

describe("emitV2 agents", () => {
  test("lead file matches the opencode 2 native format exactly", () => {
    const lead = emitV2(fixture()).find((item) => item.path === "agents/lead.md");
    expect(lead?.content).toBe(
      [
        "---",
        MARKER,
        'description: "Talks to you, plans and checks the results. Start here."',
        "mode: primary",
        'model: "anthropic/claude-opus-5-5#xhigh"',
        'color: "#0b5394"',
        "permissions:",
        "  - action: question",
        '    resource: "*"',
        "    effect: allow",
        "  - action: subagent",
        '    resource: "*"',
        "    effect: deny",
        "  - action: subagent",
        "    resource: scout",
        "    effect: allow",
        "  - action: subagent",
        "    resource: reviewer",
        "    effect: allow",
        "  - action: shell",
        '    resource: "git push *"',
        "    effect: ask",
        "---",
        "",
        "Lead prompt.",
        "",
        "Second paragraph.",
        "",
      ].join("\n"),
    );
  });

  test("writes only native agent keys, so opencode 2 never takes the legacy v1 path", () => {
    const native = new Set(["description", "mode", "model", "steps", "color", "permissions"]);
    for (const item of emitV2(fixture()).filter((entry) => entry.path.startsWith("agents/"))) {
      for (const key of Object.keys(parse(item.content).data)) expect(native.has(key)).toBe(true);
    }
  });

  test("the prompt is the body, which opencode 2 uses as the system prompt", () => {
    const files = emitV2(fixture());
    expect(file(files, "agents/lead.md").body).toBe("Lead prompt.\n\nSecond paragraph.\n");
    expect(file(files, "agents/reviewer.md").body).toBe("Reviewer prompt.\n\nSecond part.\n");
  });

  test("description and mode are written for every agent", () => {
    const files = emitV2(fixture());
    expect(file(files, "agents/lead.md").data).toMatchObject({ description: fixture().agents[0]!.description, mode: "primary" });
    expect(file(files, "agents/scout.md").data).toMatchObject({ description: "Quick read-only lookup.", mode: "subagent" });
  });

  test("model is provider/model#variant, provider/model, or absent for the session model", () => {
    const files = emitV2(fixture());
    expect(file(files, "agents/lead.md").data.model).toBe("anthropic/claude-opus-5-5#xhigh");
    expect(file(files, "agents/scout.md").data.model).toBe("anthropic/claude-sonnet-5-5#medium");
    expect(file(files, "agents/builder.md").data.model).toBe("anthropic/claude-sonnet-5-5");
    expect("model" in file(files, "agents/reviewer.md").data).toBe(false);
    expect("variant" in file(files, "agents/lead.md").data).toBe(false);
  });

  test("steps and color are written only when set", () => {
    const files = emitV2(fixture());
    expect(file(files, "agents/scout.md").data.steps).toBe(15);
    expect(file(files, "agents/builder.md").data.steps).toBe(40);
    expect("steps" in file(files, "agents/lead.md").data).toBe(false);
    expect(file(files, "agents/lead.md").data.color).toBe("#0b5394");
    expect("color" in file(files, "agents/scout.md").data).toBe(false);
  });

  test("maps neutral actions to v2 actions and keeps rule order", () => {
    const files = emitV2(fixture());
    expect(file(files, "agents/scout.md").data.permissions).toEqual([
      { action: "edit", resource: "*", effect: "deny" },
      { action: "edit", resource: ".ecmwf-multi-agents/notes/*", effect: "allow" },
      { action: "shell", resource: "*", effect: "deny" },
      { action: "shell", resource: "git log *", effect: "allow" },
      { action: "subagent", resource: "*", effect: "deny" },
      { action: "question", resource: "*", effect: "deny" },
      { action: "skill", resource: "ecmwf-multi-agents-*", effect: "deny" },
    ]);
    expect(file(files, "agents/builder.md").data.permissions).toEqual([
      { action: "shell", resource: "git commit *", effect: "deny" },
      { action: "read", resource: "*", effect: "allow" },
      { action: "glob", resource: "*", effect: "allow" },
      { action: "grep", resource: "*", effect: "allow" },
      { action: "webfetch", resource: "*", effect: "allow" },
      { action: "websearch", resource: "*", effect: "allow" },
      { action: "external_directory", resource: "~/data/*", effect: "ask" },
    ]);
  });

  test("the marker is the only frontmatter comment", () => {
    expect(file(emitV2(fixture()), "agents/scout.md").comments).toEqual([MARKER]);
  });

  test("an agent without rules gets no permissions key", () => {
    expect("permissions" in file(emitV2(fixture()), "agents/reviewer.md").data).toBe(false);
  });

  test("rejects values that opencode 2 would silently drop or ignore", () => {
    const bad: Partial<ResolvedAgent>[] = [
      { color: "primary" },
      { color: "#12345" },
      { steps: 0 },
      { steps: 2.5 },
      { model: undefined, variant: "high" },
      { model: "claude-opus-5-5" },
      { model: "anthropic/claude#x" },
      { variant: "x#y" },
      { prompt: "  \n" },
      { id: "team/lead" },
      { id: "../lead" },
    ];
    for (const change of bad) expect(() => emitV2(withAgent(change))).toThrow(/^emit-v2: /);
  });

  test("rejects two outputs for one path", () => {
    const harness = fixture();
    harness.agents.push({ ...harness.agents[1]! });
    expect(() => emitV2(harness)).toThrow("emit-v2: two outputs for agents/scout.md");
  });
});

describe("emitV2 commands", () => {
  test("writes description, agent and the template as the body", () => {
    const plan = file(emitV2(fixture()), "commands/plan.md");
    expect(plan.data).toEqual({ description: "Plan a piece of work", agent: "lead" });
    expect(plan.body).toBe("Plan: $ARGUMENTS\n");
  });

  test("subtask commands run in a child session: subagent true", () => {
    expect(file(emitV2(fixture()), "commands/review.md").data).toEqual({
      description: "Independent review",
      agent: "reviewer",
      subagent: true,
    });
  });

  test("a command for a subagent also runs in a child session without subtask, so the session never switches to a helper", () => {
    expect(file(emitV2(fixture()), "commands/status.md").data).toEqual({
      description: "Show progress",
      agent: "scout",
      subagent: true,
    });
  });

  test("without subtask, commands for primary or unknown agents leave subagent out", () => {
    const files = emitV2(fixture());
    expect("subagent" in file(files, "commands/plan.md").data).toBe(false);
    expect("subagent" in file(files, "commands/guide.md").data).toBe(false);
    expect("subtask" in file(files, "commands/review.md").data).toBe(false);
    for (const command of files.filter((output) => output.path.startsWith("commands/"))) {
      expect(file(files, command.path).data.subagent).not.toBe(false);
    }
  });
});

describe("emitV2 skills", () => {
  test("hidden skills set metadata opencode/autoinvoke to false", () => {
    const hidden = file(emitV2(fixture()), "skills/ecmwf-multi-agents-plan/SKILL.md");
    expect(hidden.data).toEqual({
      name: "ecmwf-multi-agents-plan",
      description: "Plan file format.",
      metadata: { "opencode/autoinvoke": "false" },
    });
    expect(hidden.body).toBe("# Plan\n\nRules.\n");
  });

  test("visible skills have no metadata", () => {
    expect(file(emitV2(fixture()), "skills/visible-skill/SKILL.md").data).toEqual({
      name: "visible-skill",
      description: "A listed skill.",
    });
  });
});

describe("action and model helpers", () => {
  test("every neutral action has a v2 mapping entry", () => {
    expect(Object.keys(V2_ACTIONS).sort()).toEqual(ACTIONS.filter((action) => action !== "tool").sort());
    expect(V2_ACTIONS.shell).toBe("shell");
    expect(V2_ACTIONS.delegate).toBe("subagent");
    expect(V2_ACTIONS.execute).toBe("execute");
  });


  test("a tool rule is keyed by the tool id with the pattern *, in place and in order", () => {
    expect(
      v2Permissions([
        { action: "tool", resource: "helpers_status", effect: "deny" },
        { action: "shell", resource: "ls *", effect: "allow" },
      ]),
    ).toEqual([
      { action: "helpers_status", resource: "*", effect: "deny" },
      { action: "shell", resource: "ls *", effect: "allow" },
    ]);
  });

  test("v2Permissions keeps order", () => {
    expect(
      v2Permissions([
        { action: "delegate", resource: "*", effect: "deny" },
        { action: "delegate", resource: "scout", effect: "allow" },
      ]),
    ).toEqual([
      { action: "subagent", resource: "*", effect: "deny" },
      { action: "subagent", resource: "scout", effect: "allow" },
    ]);
  });

  test("v2Model joins model and variant", () => {
    expect(v2Model("t", "openai/gpt-6.1-sol", "high")).toBe("openai/gpt-6.1-sol#high");
    expect(v2Model("t", "openai/gpt-6.1-sol")).toBe("openai/gpt-6.1-sol");
    expect(v2Model("t")).toBeUndefined();
  });
});
