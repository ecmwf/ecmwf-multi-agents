// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { lineColumn, load, markdownProblem, parseJsonc, parseVersion, templateProblem } from "./load.ts";
import { GeneratorError } from "./util.ts";

// Fixtures are loose JSON on purpose: the tests break them in every way.
type Json = any;

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

function manifest(): Json {
  return {
    name: "test-harness",
    defaultAgent: "lead",
    defaultProfile: "default",
    workDir: ".work",
    marker: "# managed by test",
    budgets: { lead: 1000, helper: 500, command: 300, skill: 400 },
    ruleSets: {
      writes: [
        { action: "shell", resource: "git push *" },
        { action: "shell", resource: "git commit *" },
      ],
    },
    agents: {
      lead: {
        mode: "primary",
        description: "Leads.",
        prompt: ["agents/lead.md"],
        budget: "lead",
        color: "#112233",
        permissions: [
          { action: "question", resource: "*", effect: "allow" },
          { use: "writes", effect: "ask" },
        ],
      },
      scout: {
        mode: "subagent",
        description: "Looks.",
        prompt: ["agents/scout.md"],
        budget: "helper",
        steps: 10,
        permissions: [{ action: "edit", resource: "*", effect: "deny" }],
      },
      builder: { mode: "subagent", description: "Builds.", prompt: ["agents/builder.md"], budget: "helper", steps: 30 },
    },
    commands: { execute: { description: "Execute.", agent: "lead", template: "commands/execute.md" } },
    skills: { "test-plan": { description: "Plan format.", body: "skills/test-plan/SKILL.md", hidden: true } },
  };
}

const MARKDOWN: Record<string, string> = {
  "agents/lead.md": "You are lead.\n\nReview policy: auto\n",
  "agents/scout.md": "You are scout.\n",
  "agents/builder.md": "You are builder.\n",
  "commands/execute.md": "Execute: $ARGUMENTS\n",
  "skills/test-plan/SKILL.md": "# Plan\n\nRules.\n",
};

const DEFAULT_PROFILE = {
  description: "Default.",
  agents: { lead: { model: "acme/big-1", effort: "high" }, scout: { model: "acme/small-1" } },
};

interface Fixture {
  manifest?: Json;
  manifestText?: string;
  /** Text of the VERSION file; null leaves the file out. */
  version?: string | null;
  /** Profile id to content; a string is written as is. */
  profiles?: Record<string, Json>;
  /** Extra or replaced Markdown files under src/; null leaves a file out. */
  markdown?: Record<string, string | null>;
}

async function fixture(options: Fixture = {}): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "ecmwf-multi-agents-load-"));
  roots.push(root);
  const files: Record<string, string> = {
    "src/manifest.jsonc": options.manifestText ?? JSON.stringify(options.manifest ?? manifest(), null, 2),
  };
  const version = options.version === undefined ? "0.1.0\n" : options.version;
  if (version !== null) files.VERSION = version;
  for (const [id, profile] of Object.entries(options.profiles ?? { default: DEFAULT_PROFILE })) {
    files[`src/profiles/${id}.jsonc`] = typeof profile === "string" ? profile : JSON.stringify(profile, null, 2);
  }
  for (const [file, text] of Object.entries({ ...MARKDOWN, ...options.markdown })) {
    if (text !== null) files[`src/${file}`] = text;
  }
  for (const [file, text] of Object.entries(files)) {
    const target = path.join(root, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, text);
  }
  return root;
}

function edited(change: (m: Json) => void): Json {
  const m = manifest();
  change(m);
  return m;
}

async function problemsOf(options: Fixture): Promise<string[]> {
  const root = await fixture(options);
  try {
    await load(root);
  } catch (error) {
    if (error instanceof GeneratorError) return [...error.problems];
    throw error;
  }
  throw new Error("load succeeded; problems were expected");
}

/** Every prefix must start one of the problems. */
function expectProblems(problems: readonly string[], ...prefixes: string[]): void {
  for (const prefix of prefixes) {
    if (!problems.some((problem) => problem.startsWith(prefix))) {
      throw new Error(`no problem starts with ${JSON.stringify(prefix)}; got:\n${problems.join("\n")}`);
    }
  }
}

describe("valid source", () => {
  test("loads agents, commands and skills in manifest order, with defaults", async () => {
    const root = await fixture({ profiles: { default: DEFAULT_PROFILE, alpha: { description: "A.", agents: {} } } });
    const source = await load(root);
    expect(source.root).toBe(root);
    expect(source.version).toBe("0.1.0");
    expect(source.manifest.agents.map((agent) => agent.id)).toEqual(["lead", "scout", "builder"]);
    expect(source.manifest.agents[2]).toEqual({
      id: "builder",
      mode: "subagent",
      description: "Builds.",
      prompt: ["agents/builder.md"],
      budget: "helper",
      steps: 30,
      permissions: [],
    });
    expect(source.manifest.agents[0]?.permissions).toEqual([
      { action: "question", resource: "*", effect: "allow" },
      { use: "writes", effect: "ask" },
    ]);
    expect(source.manifest.commands).toEqual([
      { id: "execute", description: "Execute.", agent: "lead", template: "commands/execute.md", subtask: false },
    ]);
    expect(source.manifest.skills).toEqual([
      { id: "test-plan", description: "Plan format.", body: "skills/test-plan/SKILL.md", hidden: true },
    ]);
    expect([...source.manifest.budgets]).toEqual([
      ["lead", 1000],
      ["helper", 500],
      ["command", 300],
      ["skill", 400],
    ]);
    expect(source.manifest.ruleSets.get("writes")?.length).toBe(2);
    expect(source.profiles.map((profile) => profile.id)).toEqual(["alpha", "default"]);
    expect(source.profiles[1]?.agents).toEqual(DEFAULT_PROFILE.agents);
    expect([...source.markdown.keys()].sort()).toEqual(Object.keys(MARKDOWN).sort());
    expect(source.markdown.get("agents/lead.md")).toBe(MARKDOWN["agents/lead.md"]);
  });

  test("accepts comments and trailing commas", async () => {
    const json = JSON.stringify(manifest(), null, 2);
    const manifestText = `// header comment\n${json.replace(/\n}$/, ",\n  /* block */\n}")}`;
    const profile = '{\n  // comment\n  "description": "Default.",\n  "agents": { "lead": { "model": "acme/big-1", }, },\n}';
    const source = await load(await fixture({ manifestText, profiles: { default: profile } }));
    expect(source.manifest.name).toBe("test-harness");
    expect(source.profiles[0]?.agents).toEqual({ lead: { model: "acme/big-1" } });
  });

  test("keeps manifest order for skill ids that look like numbers", async () => {
    // Written by hand: JSON.stringify would already list "42" first.
    const skills =
      '"skills": { "zeta": { "description": "Z.", "body": "skills/zeta/SKILL.md" }, "42": { "description": "A.", "body": "skills/42/SKILL.md" } }';
    const manifestText = JSON.stringify(edited((m) => (m.skills = {})), null, 2).replace('"skills": {}', skills);
    const source = await load(
      await fixture({ manifestText, markdown: { "skills/zeta/SKILL.md": "Z", "skills/42/SKILL.md": "A" } }),
    );
    expect(source.manifest.skills.map((skill) => skill.id)).toEqual(["zeta", "42"]);
    expect(source.manifest.skills[0]?.hidden).toBe(false);
  });
});

describe("JSONC", () => {
  test("syntax errors name the file, line and column", async () => {
    const problems = await problemsOf({ manifestText: '{\n  "name": "x"\n  "defaultAgent": "lead"\n}' });
    expect(problems).toEqual(["src/manifest.jsonc:3:3: expected a comma"]);
  });

  test("syntax errors in a profile are reported with the manifest's problems", async () => {
    const problems = await problemsOf({
      manifest: edited((m) => {
        m.extra = 1;
      }),
      profiles: { default: DEFAULT_PROFILE, broken: '{\n  "description": "x",\n  "agents": {\n}' },
    });
    expectProblems(problems, "src/manifest.jsonc: extra: unknown key", "src/profiles/broken.jsonc:4:2: expected a closing brace");
  });

  test("duplicate keys are errors", async () => {
    const manifestText = `{\n  "name": "again",\n${JSON.stringify(manifest(), null, 2).slice(2)}`;
    const problems = await problemsOf({ manifestText });
    expect(problems).toEqual(["src/manifest.jsonc:3:3: name: duplicate key"]);
  });

  test("parseJsonc throws a GeneratorError with every problem", () => {
    expect(parseJsonc('{ "a": [1, 2,], } // ok', "x.jsonc")).toEqual({ a: [1, 2] });
    try {
      parseJsonc('{ "a": 1 "b": }', "x.jsonc");
      throw new Error("expected a failure");
    } catch (error) {
      expect(error).toBeInstanceOf(GeneratorError);
      expect((error as GeneratorError).problems).toEqual(["x.jsonc:1:10: expected a comma", "x.jsonc:1:15: expected a value"]);
    }
    expect(() => parseJsonc("", "empty.jsonc")).toThrow("empty.jsonc:1:1: expected a value");
  });

  test("lineColumn counts from 1", () => {
    expect(lineColumn("ab\ncd", 0)).toEqual({ line: 1, column: 1 });
    expect(lineColumn("ab\ncd", 4)).toEqual({ line: 2, column: 2 });
    expect(lineColumn("ab\ncd", 99)).toEqual({ line: 2, column: 3 });
  });

  test("a __proto__ key stays data and is reported as unknown", async () => {
    const manifestText = JSON.stringify(manifest(), null, 2).replace('"name"', '"__proto__": { "x": 1 },\n  "name"');
    const problems = await problemsOf({ manifestText });
    expect(problems).toEqual([
      "src/manifest.jsonc: __proto__: unknown key; allowed keys are name, defaultAgent, defaultProfile, workDir, marker, budgets, ruleSets, agents, commands and skills",
    ]);
  });
});

describe("unknown keys", () => {
  test("are errors at every level, each with its file and key path", async () => {
    const m = edited((m) => {
      m.extra = true;
      m.agents.lead.tools = {};
      m.agents.lead.permissions[0].pattern = "*";
      m.agents.lead.permissions[1].resource = "*";
      m.ruleSets.writes[0].effect = "deny";
      m.commands.execute.model = "x/y";
      m.skills["test-plan"].license = "MIT";
    });
    const profile = { ...DEFAULT_PROFILE, models: {}, agents: { lead: { model: "acme/big-1", steps: 3 } } };
    const problems = await problemsOf({ manifest: m, profiles: { default: profile } });
    expectProblems(
      problems,
      "src/manifest.jsonc: extra: unknown key; allowed keys are name, defaultAgent,",
      "src/manifest.jsonc: agents.lead.tools: unknown key; allowed keys are mode, description,",
      "src/manifest.jsonc: agents.lead.permissions[0].pattern: unknown key; allowed keys are action, resource and effect",
      "src/manifest.jsonc: agents.lead.permissions[1].resource: unknown key; allowed keys are use and effect",
      "src/manifest.jsonc: ruleSets.writes[0].effect: unknown key; allowed keys are action and resource",
      "src/manifest.jsonc: commands.execute.model: unknown key",
      "src/manifest.jsonc: skills.test-plan.license: unknown key",
      "src/profiles/default.jsonc: models: unknown key; allowed keys are description and agents",
      "src/profiles/default.jsonc: agents.lead.steps: unknown key; allowed keys are model and effort",
    );
    expect(problems).toHaveLength(9);
  });

  test("a version in the manifest, an agent base and a profile variant are unknown keys", async () => {
    const m = edited((m) => {
      m.version = "0.1.0";
      m.agents.builder.base = "scout";
    });
    const profile = { description: "Default.", agents: { lead: { model: "acme/big-1", variant: "high" } } };
    expect(await problemsOf({ manifest: m, profiles: { default: profile } })).toEqual([
      "src/manifest.jsonc: version: unknown key; allowed keys are name, defaultAgent, defaultProfile, workDir, marker, budgets, ruleSets, agents, commands and skills",
      "src/manifest.jsonc: agents.builder.base: unknown key; allowed keys are mode, description, prompt, budget, steps, color and permissions",
      "src/profiles/default.jsonc: agents.lead.variant: unknown key; allowed keys are model and effort",
    ]);
  });
});

describe("top level", () => {
  test("required keys, workDir and marker", async () => {
    const m = edited((m) => {
      delete m.name;
      m.workDir = "../work";
      m.marker = "managed";
    });
    const problems = await problemsOf({ manifest: m });
    expect(problems).toEqual([
      "src/manifest.jsonc: name: required key is missing",
      'src/manifest.jsonc: workDir: must be a normalised relative path without "." or ".." segments',
      'src/manifest.jsonc: marker: must start with "#", because it is written as a YAML comment',
    ]);
  });

  test("marker must be one line and workDir relative", async () => {
    const m = edited((m) => {
      m.marker = "# one\n# two";
      m.workDir = "/abs";
    });
    const problems = await problemsOf({ manifest: m });
    expect(problems).toEqual([
      "src/manifest.jsonc: workDir: must be relative to the project root",
      "src/manifest.jsonc: marker: must be a single line",
    ]);
  });

  test("defaultAgent must exist and be primary; defaultProfile must be a profile", async () => {
    expect(
      await problemsOf({
        manifest: edited((m) => {
          m.defaultAgent = "scout";
          m.defaultProfile = "fast";
        }),
      }),
    ).toEqual([
      "src/manifest.jsonc: defaultAgent: agent scout is a subagent; the default agent must be primary",
      "src/manifest.jsonc: defaultProfile: names no profile; profiles in src/profiles/: default",
    ]);
    expect(
      await problemsOf({
        manifest: edited((m) => {
          m.defaultAgent = "boss";
        }),
      }),
    ).toEqual(["src/manifest.jsonc: defaultAgent: names no agent; agents: lead, scout and builder"]);
  });

  test("budgets need valid names and limits, and command and skill budgets when used", async () => {
    const m = edited((m) => {
      m.budgets = { lead: 0, helper: 500, Big: 10 };
    });
    expect(await problemsOf({ manifest: m })).toEqual([
      "src/manifest.jsonc: budgets.lead: must be a whole number of at least 1, not the number 0",
      "src/manifest.jsonc: budgets.Big: budget name must match ^[a-z][a-z0-9-]*$",
      "src/manifest.jsonc: budgets.command: required key is missing; every command template is checked against it",
      "src/manifest.jsonc: budgets.skill: required key is missing; every skill body is checked against it",
    ]);
  });

  test("rule sets are non-empty lists of action and resource", async () => {
    const m = edited((m) => {
      m.ruleSets.empty = [];
      m.ruleSets.flat = "git *";
      m.ruleSets.writes.push({ action: "bash", resource: "" });
    });
    expect(await problemsOf({ manifest: m })).toEqual([
      'src/manifest.jsonc: ruleSets.writes[2].action: must be "read", "edit", "glob", "grep", "shell", "delegate", "skill", "question", "webfetch", "websearch", "external_directory", "execute" or "tool", not "bash"',
      "src/manifest.jsonc: ruleSets.writes[2].resource: must be a non-empty string, not an empty string",
      'src/manifest.jsonc: ruleSets.empty: must be a non-empty list of {"action", "resource"} items, not an empty list',
      'src/manifest.jsonc: ruleSets.flat: must be a non-empty list of {"action", "resource"} items, not "git *"',
    ]);
  });

  test("a tool rule names one plugin tool id, never a pattern or a tool of opencode itself", async () => {
    const m = edited((m) => {
      m.ruleSets.writes.push({ action: "tool", resource: "helpers_*" });
      m.ruleSets.writes.push({ action: "tool", resource: "Helpers" });
      m.ruleSets.writes.push({ action: "tool", resource: "shell" });
      m.ruleSets.writes.push({ action: "tool", resource: "helpers_status" });
      m.agents.scout.permissions.push({ action: "tool", resource: "session_move", effect: "deny" });
      m.agents.scout.permissions.push({ action: "tool", resource: "helpers_cancel", effect: "deny" });
    });
    expect(await problemsOf({ manifest: m })).toEqual([
      'src/manifest.jsonc: ruleSets.writes[2].resource: a tool rule names one tool id, lowercase words joined by underscores, not "helpers_*"',
      'src/manifest.jsonc: ruleSets.writes[3].resource: a tool rule names one tool id, lowercase words joined by underscores, not "Helpers"',
      'src/manifest.jsonc: ruleSets.writes[4].resource: "shell" is a tool of opencode itself; use its own action instead of a tool rule',
      'src/manifest.jsonc: agents.scout.permissions[1].resource: "session_move" is a tool of opencode itself; use its own action instead of a tool rule',
    ]);
  });
});

describe("agents", () => {
  test("ids must be lowercase words joined by hyphens", async () => {
    const m = edited((m) => {
      m.agents.Bad_Id = { mode: "subagent", description: "x", prompt: ["agents/scout.md"], budget: "helper" };
      m.agents["9lives"] = { mode: "subagent", description: "x", prompt: ["agents/lead.md"], budget: "helper" };
    });
    expect(await problemsOf({ manifest: m })).toEqual([
      "src/manifest.jsonc: agents.Bad_Id: agent id must match ^[a-z][a-z0-9-]*$",
      "src/manifest.jsonc: agents.9lives: agent id must match ^[a-z][a-z0-9-]*$",
    ]);
  });

  test("mode, budget, steps, description, color and prompt", async () => {
    const m = edited((m) => {
      delete m.agents.scout.mode;
      delete m.agents.scout.budget;
      m.agents.lead.mode = "boss";
      m.agents.lead.budget = "huge";
      m.agents.lead.steps = 1.5;
      m.agents.lead.color = 7;
      m.agents.lead.description = " ";
      m.agents.builder.steps = 0;
      m.agents.builder.prompt = [];
    });
    expect(await problemsOf({ manifest: m })).toEqual([
      'src/manifest.jsonc: agents.lead.mode: must be "primary" or "subagent", not "boss"',
      "src/manifest.jsonc: agents.lead.description: must be a non-empty string, not an empty string",
      "src/manifest.jsonc: agents.lead.budget: names no budget; budgets: lead, helper, command and skill",
      "src/manifest.jsonc: agents.lead.steps: must be a whole number of at least 1, not the number 1.5",
      "src/manifest.jsonc: agents.lead.color: must be a non-empty string, not the number 7",
      "src/manifest.jsonc: agents.scout.mode: required key is missing",
      "src/manifest.jsonc: agents.scout.budget: required key is missing",
      "src/manifest.jsonc: agents.builder.prompt: must be a non-empty list of Markdown paths relative to src/, not an empty list",
      "src/manifest.jsonc: agents.builder.steps: must be a whole number of at least 1, not the number 0",
    ]);
  });

  test("every agent needs mode, description, prompt and budget", async () => {
    const m = edited((m) => {
      m.agents.builder = {};
      delete m.agents.lead.mode;
    });
    // The default agent's missing mode is reported once, not again as a mode that is not primary.
    expect(await problemsOf({ manifest: m })).toEqual([
      "src/manifest.jsonc: agents.lead.mode: required key is missing",
      "src/manifest.jsonc: agents.builder.mode: required key is missing",
      "src/manifest.jsonc: agents.builder.description: required key is missing",
      "src/manifest.jsonc: agents.builder.prompt: required key is missing",
      "src/manifest.jsonc: agents.builder.budget: required key is missing",
    ]);
  });

  test("prompt paths stay inside src/ and name Markdown files", async () => {
    const m = edited((m) => {
      m.agents.lead.prompt = ["../outside.md", "/abs.md", "agents\\lead.md", "agents/lead.txt", "agents/lead.md", "agents/lead.md"];
    });
    expect(await problemsOf({ manifest: m })).toEqual([
      'src/manifest.jsonc: agents.lead.prompt[0]: path "../outside.md" has a ".." segment; paths are relative to src/',
      'src/manifest.jsonc: agents.lead.prompt[1]: path "/abs.md" is absolute; paths are relative to src/',
      'src/manifest.jsonc: agents.lead.prompt[2]: path "agents\\\\lead.md" uses "\\"; separate segments with "/"; paths are relative to src/',
      'src/manifest.jsonc: agents.lead.prompt[3]: path "agents/lead.txt" must name a Markdown file ending in .md',
      "src/manifest.jsonc: agents.lead.prompt[5]: lists agents/lead.md twice",
    ]);
  });

  test("permission entries: rule sets, actions and effects", async () => {
    const m = edited((m) => {
      m.agents.lead.permissions = [
        { use: "reads", effect: "allow" },
        { action: "bash", resource: "*", effect: "deny" },
        { action: "edit", resource: "*", effect: "maybe" },
        { action: "execute", resource: "*", effect: "deny" },
        "deny all",
        { action: "edit", effect: "deny" },
      ];
      m.agents.scout.permissions = { edit: "deny" };
    });
    expect(await problemsOf({ manifest: m })).toEqual([
      "src/manifest.jsonc: agents.lead.permissions[0].use: names no rule set; rule sets: writes",
      'src/manifest.jsonc: agents.lead.permissions[1].action: must be "read", "edit", "glob", "grep", "shell", "delegate", "skill", "question", "webfetch", "websearch", "external_directory", "execute" or "tool", not "bash"',
      'src/manifest.jsonc: agents.lead.permissions[2].effect: must be "allow", "ask" or "deny", not "maybe"',
      'src/manifest.jsonc: agents.lead.permissions[4]: must be an object, not "deny all"',
      "src/manifest.jsonc: agents.lead.permissions[5].resource: required key is missing",
      "src/manifest.jsonc: agents.scout.permissions: must be a list, not an object",
    ]);
  });
});

describe("commands and skills", () => {
  test("command id, agent, template and subtask", async () => {
    const m = edited((m) => {
      m.commands.Execute = { description: "Execute.", agent: "lead", template: "commands/execute.md" };
      m.commands.execute.agent = "boss";
      m.commands.execute.subtask = "yes";
      m.commands.check = { description: "Check.", agent: "scout" };
    });
    expect(await problemsOf({ manifest: m })).toEqual([
      "src/manifest.jsonc: commands.execute.agent: names no agent; agents: lead, scout and builder",
      'src/manifest.jsonc: commands.execute.subtask: must be true or false, not "yes"',
      "src/manifest.jsonc: commands.Execute: command id must match ^[a-z][a-z0-9-]*$",
      "src/manifest.jsonc: commands.check.template: required key is missing",
    ]);
  });

  test("skill ids are lowercase, hyphenated and at most 64 characters", async () => {
    const long = `s${"-a".repeat(32)}`;
    expect(long).toHaveLength(65);
    const m = edited((m) => {
      m.skills[long] = { description: "Long.", body: "skills/test-plan/SKILL.md" };
      m.skills.Bad_Skill = { description: "Bad.", body: "skills/test-plan/SKILL.md", hidden: "no" };
      m.skills["ok-skill"] = { body: "skills/test-plan/SKILL.md" };
    });
    expect(await problemsOf({ manifest: m })).toEqual([
      `src/manifest.jsonc: skills.${long}: skill id has 65 characters; at most 64 are allowed`,
      "src/manifest.jsonc: skills.Bad_Skill: skill id must match ^[a-z0-9]+(-[a-z0-9]+)*$",
      'src/manifest.jsonc: skills.Bad_Skill.hidden: must be true or false, not "no"',
      "src/manifest.jsonc: skills.ok-skill.description: required key is missing",
    ]);
  });
});

describe("Markdown files", () => {
  test("a missing file names the file and the key path", async () => {
    expect(await problemsOf({ markdown: { "agents/scout.md": null } })).toEqual([
      "src/manifest.jsonc: agents.scout.prompt[0]: src/agents/scout.md does not exist",
    ]);
  });

  test("frontmatter, a leading comment, an empty file and a directory are errors", async () => {
    const root = await fixture({
      markdown: {
        "agents/lead.md": "---\ndescription: x\n---\n\nYou are lead.\n\nReview policy: auto\n",
        "agents/scout.md": "\n\n---\nmode: subagent\n---\nBody",
        // A licence header comment, split so that licence scanners do not read it as this file's.
        "commands/execute.md": `<!--\n${"SPDX-"}License-Identifier: Apache-2.0\n-->\n\nGo.`,
        "agents/builder.md": " \n\n",
        "skills/test-plan/SKILL.md": null,
      },
    });
    await mkdir(path.join(root, "src/skills/test-plan/SKILL.md"), { recursive: true });
    const problems = await load(root).then(
      () => [],
      (error: GeneratorError) => [...error.problems],
    );
    expect(problems).toEqual([
      'src/agents/lead.md: starts with "---": source Markdown carries no frontmatter; the generator writes it from the manifest (named at agents.lead.prompt[0] in src/manifest.jsonc)',
      'src/agents/scout.md: starts with "---": source Markdown carries no frontmatter; the generator writes it from the manifest (named at agents.scout.prompt[0] in src/manifest.jsonc)',
      "src/agents/builder.md: is empty (named at agents.builder.prompt[0] in src/manifest.jsonc)",
      'src/commands/execute.md: starts with "<!--": the comment would reach the model; prompt files get their licence from REUSE.toml (named at commands.execute.template in src/manifest.jsonc)',
      "src/manifest.jsonc: skills.test-plan.body: src/skills/test-plan/SKILL.md is a directory, not a file",
    ]);
  });

  test("command templates must not run shell commands", async () => {
    const problems = await problemsOf({ markdown: { "commands/execute.md": "Status:\n!`git status`\n" } });
    expect(problems).toEqual([
      'src/commands/execute.md: has a "!`command`" block, which opencode runs before any permission check; templates must not run commands (named at commands.execute.template in src/manifest.jsonc)',
    ]);
  });

  test("markdownProblem and templateProblem", () => {
    expect(markdownProblem("Body\n---\n")).toBeUndefined();
    expect(markdownProblem("\uFEFF---\n")).toStartWith('starts with "---"');
    expect(markdownProblem("  <!-- x -->")).toStartWith('starts with "<!--"');
    expect(markdownProblem("")).toBe("is empty");
    expect(templateProblem("Run `git status` yourself.")).toBeUndefined();
    expect(templateProblem("!`ls`")).toBeDefined();
  });
});

describe("profiles", () => {
  test("models, efforts and agent ids", async () => {
    const profile = {
      description: "Broken.",
      agents: {
        lead: { model: "acme", effort: "high" },
        scout: { model: "Acme/x", effort: "hi#gh" },
        builder: { model: "acme/x#high" },
        boss: { model: "acme/x" },
      },
    };
    const other = {
      description: "Efforts.",
      agents: { lead: { effort: "high" }, scout: { model: "acme/has space", effort: "very high" }, builder: { model: "acme/x", effort: "" } },
    };
    const problems = await problemsOf({ profiles: { default: DEFAULT_PROFILE, broken: profile, other } });
    expect(problems).toEqual([
      'src/profiles/broken.jsonc: agents.lead.model: "acme" must look like provider/model, with a lowercase provider id and no spaces',
      'src/profiles/broken.jsonc: agents.scout.model: "Acme/x" must look like provider/model, with a lowercase provider id and no spaces',
      'src/profiles/broken.jsonc: agents.scout.effort: "hi#gh" must be one word without "#", such as high',
      'src/profiles/broken.jsonc: agents.builder.model: "acme/x#high" must not contain "#"; set the effort separately',
      "src/profiles/broken.jsonc: agents.boss: names no agent of the manifest; agents: lead, scout and builder",
      "src/profiles/other.jsonc: agents.lead.effort: an effort needs a model in the same entry",
      'src/profiles/other.jsonc: agents.scout.model: "acme/has space" must look like provider/model, with a lowercase provider id and no spaces',
      'src/profiles/other.jsonc: agents.scout.effort: "very high" must be one word without "#", such as high',
      "src/profiles/other.jsonc: agents.builder.effort: must be a non-empty string, not an empty string",
    ]);
  });

  test("profile ids come from file names; description and agents are required", async () => {
    const problems = await problemsOf({
      profiles: { default: DEFAULT_PROFILE, Bad_Name: { description: "x", agents: {} }, thin: { agents: [] } },
    });
    expect(problems).toEqual([
      'src/profiles/Bad_Name.jsonc: (file name): profile id "Bad_Name" must match ^[a-z0-9]+(-[a-z0-9]+)*$',
      "src/profiles/thin.jsonc: description: required key is missing",
      "src/profiles/thin.jsonc: agents: must be an object, not an empty list",
    ]);
  });
});

describe("VERSION", () => {
  test("holds exactly one line with three whole numbers, with or without a final line break", () => {
    expect(parseVersion("0.1.0\n")).toEqual({ version: "0.1.0" });
    expect(parseVersion("12.30.4")).toEqual({ version: "12.30.4" });
    const problems: [string, string][] = [
      ["", "is empty; it must hold one line with the version, such as 1.2.3"],
      ["\n", "is empty; it must hold one line with the version, such as 1.2.3"],
      ["v0.1.0\n", '"v0.1.0" starts with "v"; write the version without it, as 0.1.0'],
      ["V1.2.3", '"V1.2.3" starts with "V"; write the version without it, as 1.2.3'],
      ["0.1.0\n0.2.0\n", "has 2 lines; it must hold exactly one, the version, such as 1.2.3"],
      ["0.1.0\n\n", "has 2 lines; it must hold exactly one, the version, such as 1.2.3"],
      ["0.1\n", '"0.1" is not a version such as 1.2.3: three whole numbers separated by dots, and nothing else'],
      ["0.1.0-rc.1\n", '"0.1.0-rc.1" is not a version such as 1.2.3: three whole numbers separated by dots, and nothing else'],
      [" 0.1.0\n", '" 0.1.0" is not a version such as 1.2.3: three whole numbers separated by dots, and nothing else'],
      ["0.1.0\r\n", '"0.1.0\\r" is not a version such as 1.2.3: three whole numbers separated by dots, and nothing else'],
    ];
    for (const [text, problem] of problems) expect({ text, result: parseVersion(text) }).toEqual({ text, result: { problem } });
  });

  test("problems name the file and are reported with the others", async () => {
    expect(await problemsOf({ version: null })).toEqual(["VERSION: does not exist; it must hold the harness version, such as 1.2.3"]);
    const m = edited((m) => {
      m.commands.execute.agent = "nobody";
    });
    expect(await problemsOf({ manifest: m, version: "v0.2.0\n" })).toEqual([
      "src/manifest.jsonc: commands.execute.agent: names no agent; agents: lead, scout and builder",
      'VERSION: "v0.2.0" starts with "v"; write the version without it, as 0.2.0',
    ]);
  });
});

test("every problem is reported in one run", async () => {
  const m = edited((m) => {
    m.agents.scout.mode = "helper";
    m.commands.execute.agent = "nobody";
  });
  const problems = await problemsOf({ manifest: m, markdown: { "skills/test-plan/SKILL.md": null } });
  expect(problems).toHaveLength(3);
  expectProblems(
    problems,
    "src/manifest.jsonc: agents.scout.mode:",
    "src/manifest.jsonc: commands.execute.agent:",
    "src/manifest.jsonc: skills.test-plan.body: src/skills/test-plan/SKILL.md does not exist",
  );
});
