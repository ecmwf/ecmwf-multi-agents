// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  emitV1,
  V1_ACTIONS,
  v1AgentFile,
  v1Color,
  v1CommandFile,
  v1Permission,
  v1SkillFile,
} from "./emit-v1.ts";
import { ACTIONS, type OutputFile, type ResolvedAgent, type ResolvedHarness, type Rule } from "./types.ts";

const MARKER = "# managed by ecmwf-multi-agents";

const lead: ResolvedAgent = {
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
};

const scout: ResolvedAgent = {
  id: "scout",
  mode: "subagent",
  description: "Read-only lookups and investigations in code, docs or the web.",
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
};

// Covers the remaining actions, so every mapping is exercised by the harness fixture.
const builder: ResolvedAgent = {
  id: "builder",
  mode: "subagent",
  description: "Makes one clearly specified change, runs its checks and reports.",
  prompt: "You are builder.",
  steps: 60,
  color: "accent",
  model: "anthropic/claude-sonnet-5-5",
  variant: "high",
  permissions: [
    { action: "read", resource: "*.env", effect: "deny" },
    { action: "glob", resource: "*", effect: "allow" },
    { action: "grep", resource: "*", effect: "allow" },
    { action: "list", resource: "*", effect: "allow" },
    { action: "webfetch", resource: "*", effect: "ask" },
    { action: "websearch", resource: "*", effect: "deny" },
    { action: "external_directory", resource: "/tmp/builds/*", effect: "allow" },
    { action: "shell", resource: "git push *", effect: "deny" },
    { action: "shell", resource: "gh *", effect: "deny" },
  ],
};

// No model of its own, so it runs on the session model: no model, variant or color is written.
const reviewer: ResolvedAgent = {
  id: "reviewer",
  mode: "subagent",
  description: "Independent review of a plan or a change.",
  prompt: "You are reviewer.",
  steps: 30,
  permissions: [
    { action: "edit", resource: "*", effect: "deny" },
    { action: "shell", resource: "gh *", effect: "deny" },
    { action: "shell", resource: "gh pr view *", effect: "allow" },
    { action: "delegate", resource: "*", effect: "deny" },
    { action: "execute", resource: "*", effect: "deny" },
  ],
};

const harness: ResolvedHarness = {
  name: "ecmwf-multi-agents",
  version: "0.1.0",
  defaultAgent: "lead",
  defaultProfile: "default",
  workDir: ".ecmwf-multi-agents",
  marker: MARKER,
  agents: [lead, scout, builder, reviewer],
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

interface Parsed {
  lines: string[];
  data: Record<string, unknown>;
  body: string;
}

/** Split a generated file into its frontmatter lines, parsed frontmatter and body. */
function parse(content: string): Parsed {
  expect(content.startsWith("---\n")).toBe(true);
  const end = content.indexOf("\n---\n", 3);
  expect(end).toBeGreaterThan(0);
  const head = content.slice(4, end);
  return {
    lines: head.split("\n"),
    data: Bun.YAML.parse(head) as Record<string, unknown>,
    body: content.slice(end + 5),
  };
}

function file(files: OutputFile[], path: string): Parsed {
  const found = files.find((item) => item.path === path);
  if (found === undefined) throw new Error(`no output ${path}`);
  return parse(found.content);
}

// Rule matching as opencode 1.x does it (core/src/util/wildcard.ts and permission/index.ts at
// v1.18.35): "*" matches anything including "/", a trailing " *" also matches nothing, and the
// last matching rule wins; with no match the answer is "ask".
function wildcard(input: string, pattern: string): boolean {
  let escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  if (escaped.endsWith(" .*")) escaped = `${escaped.slice(0, -3)}( .*)?`;
  return new RegExp(`^${escaped}$`, "s").test(input);
}

type V1Rule = { permission: string; pattern: string; action: string };

function fromConfig(map: Record<string, unknown>): V1Rule[] {
  const out: V1Rule[] = [];
  for (const [permission, value] of Object.entries(map)) {
    if (typeof value === "string") out.push({ permission, pattern: "*", action: value });
    else for (const [pattern, action] of Object.entries(value as Record<string, string>)) out.push({ permission, pattern, action });
  }
  return out;
}

function decide(rules: V1Rule[], permission: string, input: string): string {
  for (let i = rules.length - 1; i >= 0; i--) {
    const rule = rules[i]!;
    if (wildcard(permission, rule.permission) && wildcard(input, rule.pattern)) return rule.action;
  }
  return "ask";
}

const PROBES = [
  "*",
  "git push",
  "git push origin main",
  "git log",
  "git log --oneline",
  "ls",
  "ls -la src",
  "rm -rf build",
  "gh pr view 12",
  "gh",
  ".ecmwf-multi-agents/notes/a.md",
  ".ecmwf-multi-agents/notes/sub/b.md",
  "sub/.ecmwf-multi-agents/notes/c.md",
  ".ecmwf-multi-agents/plans/p.md",
  "src/main.ts",
  ".env",
  "scout",
  "scoutx",
  "builder",
  "reviewer",
  "general",
  "ecmwf-multi-agents-plan",
  "other-skill",
  "/tmp/builds/x",
];

describe("emitV1", () => {
  const files = emitV1(harness);

  test("writes one file per agent, command and skill, sorted by path", () => {
    expect(files.map((item) => item.path)).toEqual([
      "agents/builder.md",
      "agents/lead.md",
      "agents/reviewer.md",
      "agents/scout.md",
      "commands/plan.md",
      "commands/review.md",
      "commands/status.md",
      "skills/ecmwf-multi-agents-guide/SKILL.md",
      "skills/ecmwf-multi-agents-plan/SKILL.md",
    ]);
  });

  test("every file starts its frontmatter with the marker comment", () => {
    for (const item of files) expect(item.content.split("\n").slice(0, 2)).toEqual(["---", MARKER]);
  });

  test("agent frontmatter has the fields in a fixed order and the prompt as body", () => {
    const { lines, data, body } = file(files, "agents/lead.md");
    const keys = lines.filter((line) => /^[A-Za-z"]/.test(line)).map((line) => line.split(":")[0]);
    expect(keys).toEqual(["description", "mode", "model", "variant", "color", "permission"]);
    expect(data).toEqual({
      description: lead.description,
      mode: "primary",
      model: "anthropic/claude-opus-5-5",
      variant: "xhigh",
      color: "#0b5394",
      permission: {
        question: "allow",
        task: { "*": "deny", scout: "allow", builder: "allow", reviewer: "allow" },
        bash: { "git push *": "ask", "gh pr merge *": "ask" },
      },
    });
    expect(body).toBe("\nYou are lead.\n\nReview policy: auto\n");
  });

  test("steps appear for helpers; model and variant only when set", () => {
    expect(file(files, "agents/scout.md").data).toMatchObject({
      mode: "subagent",
      model: "anthropic/claude-sonnet-5-5",
      variant: "medium",
      steps: 30,
    });
    const own = file(files, "agents/reviewer.md").data;
    expect(own.steps).toBe(30);
    expect("model" in own).toBe(false);
    expect("variant" in own).toBe(false);
    expect("color" in own).toBe(false);
  });

  test("maps every neutral action: shell to bash, delegate to task, todo to todowrite, others by name", () => {
    expect(V1_ACTIONS).toEqual({
      read: "read",
      edit: "edit",
      glob: "glob",
      grep: "grep",
      list: "list",
      shell: "bash",
      delegate: "task",
      skill: "skill",
      question: "question",
      webfetch: "webfetch",
      websearch: "websearch",
      todo: "todowrite",
      external_directory: "external_directory",
      execute: null,
    });
    const mappable = ACTIONS.filter((action): action is Exclude<Rule["action"], "tool"> => action !== "tool");
    const all = mappable.map((action): Rule => ({ action, resource: "*", effect: "deny" }));
    const mapped = mappable.map((action) => V1_ACTIONS[action]).filter((key): key is string => key !== null);
    expect(Object.keys(v1Permission(all))).toEqual(mapped);
    expect(file(files, "agents/builder.md").data.permission).toEqual({
      read: { "*.env": "deny" },
      glob: { "*": "allow" },
      grep: { "*": "allow" },
      list: { "*": "allow" },
      webfetch: "ask",
      websearch: "deny",
      external_directory: { "/tmp/builds/*": "allow" },
      bash: { "git push *": "deny", "gh *": "deny" },
    });
  });


  test("a tool rule becomes a flat key named by the tool id, one effect for the tool, last rule wins", () => {
    expect(
      v1Permission([
        { action: "tool", resource: "helpers_status", effect: "deny" },
        { action: "shell", resource: "ls *", effect: "allow" },
        { action: "tool", resource: "helpers_steer", effect: "deny" },
        { action: "tool", resource: "helpers_status", effect: "allow" },
      ]),
    ).toEqual({ bash: { "ls *": "allow" }, helpers_steer: "deny", helpers_status: "allow" });
  });
  test("drops rules for actions opencode 1.x does not have", () => {
    const rules: Rule[] = [
      { action: "execute", resource: "*", effect: "deny" },
      { action: "edit", resource: "*", effect: "deny" },
      { action: "execute", resource: "*", effect: "allow" },
    ];
    expect(JSON.stringify(v1Permission(rules))).toBe(JSON.stringify({ edit: { "*": "deny" } }));
    expect(v1Permission([{ action: "execute", resource: "*", effect: "deny" }])).toEqual({});
    expect(file(files, "agents/reviewer.md").data.permission).toEqual({
      edit: { "*": "deny" },
      bash: { "gh *": "deny", "gh pr view *": "allow" },
      task: { "*": "deny" },
    });
  });

  test("groups rules per key in order of first appearance, keeping their order within a key", () => {
    const permission = file(files, "agents/scout.md").data.permission as Record<string, unknown>;
    expect(Object.keys(permission)).toEqual(["edit", "bash", "task", "question", "todowrite", "skill"]);
    expect(Object.keys(permission.edit as object)).toEqual(["*", ".ecmwf-multi-agents/notes/*", "*/.ecmwf-multi-agents/notes/*"]);
    expect(Object.keys(permission.bash as object)).toEqual(["*", "git log *", "ls *"]);
    const interleaved: Rule[] = [
      { action: "edit", resource: "*", effect: "deny" },
      { action: "shell", resource: "*", effect: "deny" },
      { action: "edit", resource: "docs/*", effect: "allow" },
      { action: "shell", resource: "ls *", effect: "allow" },
    ];
    expect(JSON.stringify(v1Permission(interleaved))).toBe(
      JSON.stringify({ edit: { "*": "deny", "docs/*": "allow" }, bash: { "*": "deny", "ls *": "allow" } }),
    );
  });

  test("a repeated pattern moves to its latest position", () => {
    const rules: Rule[] = [
      { action: "shell", resource: "git *", effect: "deny" },
      { action: "shell", resource: "git log *", effect: "allow" },
      { action: "shell", resource: "git *", effect: "deny" },
    ];
    expect(JSON.stringify(v1Permission(rules))).toBe(JSON.stringify({ bash: { "git log *": "allow", "git *": "deny" } }));
  });

  test("emitted maps decide every probe exactly as the neutral rule lists do", () => {
    const lists: Rule[][] = [
      ...harness.agents.map((agent) => agent.permissions),
      [
        { action: "shell", resource: "git *", effect: "deny" },
        { action: "shell", resource: "git log *", effect: "allow" },
        { action: "edit", resource: "*", effect: "allow" },
        { action: "shell", resource: "git *", effect: "ask" },
        { action: "edit", resource: ".ecmwf-multi-agents/*", effect: "deny" },
        { action: "edit", resource: "*", effect: "deny" },
        { action: "edit", resource: ".ecmwf-multi-agents/notes/*", effect: "allow" },
      ],
    ];
    for (const rules of lists) {
      const neutral = rules.flatMap((rule) => {
        if (rule.action === "tool") return [{ permission: rule.resource, pattern: "*", action: rule.effect }];
        const permission = V1_ACTIONS[rule.action];
        return permission === null ? [] : [{ permission, pattern: rule.resource, action: rule.effect }];
      });
      const emitted = fromConfig(v1Permission(rules));
      for (const key of new Set(neutral.map((rule) => rule.permission))) {
        for (const probe of PROBES) expect(`${key} ${probe}: ${decide(emitted, key, probe)}`).toBe(`${key} ${probe}: ${decide(neutral, key, probe)}`);
      }
    }
  });

  test("writes 'X *' patterns as they are, since they also match a bare 'X'", () => {
    const bash = (file(files, "agents/lead.md").data.permission as Record<string, Record<string, string>>).bash!;
    expect(Object.keys(bash)).toEqual(["git push *", "gh pr merge *"]);
    expect(wildcard("git push", "git push *")).toBe(true);
    expect(wildcard("git pushx", "git push *")).toBe(false);
  });

  test("collapses keys that take one action to that action", () => {
    expect(file(files, "agents/scout.md").data.permission).toMatchObject({ question: "deny", todowrite: "deny" });
    const rules: Rule[] = [
      { action: "question", resource: "*", effect: "deny" },
      { action: "webfetch", resource: "*", effect: "allow" },
      { action: "question", resource: "*", effect: "allow" },
      { action: "websearch", resource: "*", effect: "ask" },
    ];
    expect(v1Permission(rules)).toEqual({ question: "allow", webfetch: "allow", websearch: "ask" });
  });

  test("throws when a key that takes one action has a resource other than '*'", () => {
    for (const action of ["question", "todo", "webfetch", "websearch"] as const) {
      expect(() => v1Permission([{ action, resource: "https://example.org/*", effect: "deny" }], "agent x")).toThrow(
        `emit-v1: agent x: ${action} takes one action for every resource in opencode 1.x`,
      );
    }
  });

  test("color: #RRGGBB and theme names are written, anything else is left out", () => {
    expect(v1Color("#0b5394")).toBe("#0b5394");
    expect(v1Color("#0B5394")).toBe("#0B5394");
    expect(v1Color("accent")).toBe("accent");
    expect(v1Color(undefined)).toBeUndefined();
    for (const bad of ["#abc", "#0b5394ff", "red", "0b5394", ""]) expect(v1Color(bad)).toBeUndefined();
    expect(file(files, "agents/builder.md").data.color).toBe("accent");
    expect(file(files, "agents/scout.md").data.color).toBeUndefined();
    const content = v1AgentFile({ ...scout, color: "#abc" }, MARKER).content;
    expect(content).not.toContain("color");
  });

  test("rejects values that would stop opencode 1.x from starting or change what it does", () => {
    const cases: [Partial<ResolvedAgent>, string][] = [
      [{ steps: 0 }, "steps must be a positive integer"],
      [{ steps: 2.5 }, "steps must be a positive integer"],
      [{ model: undefined, variant: "high" }, "needs a model"],
      [{ model: "claude-opus-5-5" }, "is not provider/model"],
      [{ variant: "x high" }, "is not a single word"],
      [{ id: "sub/scout" }, "is not a single file-name segment"],
      [{ prompt: " \n " }, "empty prompt"],
      [{ permissions: [{ action: "shell", resource: "1", effect: "deny" }] }, "cannot keep its order"],
    ];
    for (const [change, message] of cases) expect(() => v1AgentFile({ ...scout, ...change }, MARKER)).toThrow(message);
    expect(() => emitV1({ ...harness, marker: `${MARKER}\n# second line` })).toThrow("marker must be a single line");
    expect(() => emitV1({ ...harness, agents: [lead, lead] })).toThrow("two outputs for agents/lead.md");
  });

  test("commands carry description and agent; subtask true only when set", () => {
    const plan = file(files, "commands/plan.md");
    expect(plan.data).toEqual({ description: "Plan a piece of work with you", agent: "lead" });
    expect(plan.body).toBe("\nPlan: $ARGUMENTS\n");
    expect(file(files, "commands/review.md").data).toEqual({
      description: "Independent review of your changes",
      agent: "reviewer",
      subtask: true,
    });
  });

  test("a command whose agent is a subagent gets subtask false, which opencode 1.x would otherwise assume true", () => {
    expect(file(files, "commands/status.md").data).toEqual({
      description: "Show progress on the current plan",
      agent: "scout",
      subtask: false,
    });
    const modes = new Map([["general", "subagent" as const]]);
    const builtIn = v1CommandFile({ id: "x", description: "d", agent: "build", subtask: false, template: "t" }, MARKER, modes);
    expect(parse(builtIn.content).data).toEqual({ description: "d", agent: "build" });
  });

  test("hidden skills have no description; visible skills keep theirs", () => {
    const hidden = file(files, "skills/ecmwf-multi-agents-plan/SKILL.md");
    expect(hidden.data).toEqual({ name: "ecmwf-multi-agents-plan" });
    expect(hidden.body).toBe("\n# Plan\n\nRules.\n");
    expect(file(files, "skills/ecmwf-multi-agents-guide/SKILL.md").data).toEqual({
      name: "ecmwf-multi-agents-guide",
      description: "User guide to the harness.",
    });
    expect(() => v1SkillFile({ id: "a/b", description: "d", body: "b", hidden: false }, MARKER)).toThrow("single file-name segment");
  });

  test("output is deterministic, uses LF only and ends with exactly one newline", () => {
    expect(emitV1(harness)).toEqual(files);
    const reversed = emitV1({
      ...harness,
      agents: [...harness.agents].reverse(),
      commands: [...harness.commands].reverse(),
      skills: [...harness.skills].reverse(),
    });
    expect(reversed).toEqual(files);
    const crlf = emitV1({
      ...harness,
      agents: [{ ...lead, prompt: "Line one.\r\nLine two.\r\n" }],
      commands: [{ id: "go", description: "Go\r\non", agent: "lead", subtask: false, template: "Step 1.\r\nStep 2." }],
      skills: [{ id: "s", description: "d", body: "a\r\nb", hidden: false }],
    });
    for (const item of [...files, ...crlf]) {
      expect(item.content).not.toContain("\r");
      expect(item.content.endsWith("\n")).toBe(true);
      expect(item.content.endsWith("\n\n")).toBe(false);
    }
    expect(parse(crlf[0]!.content).body).toBe("\nLine one.\nLine two.\n");
  });
});
