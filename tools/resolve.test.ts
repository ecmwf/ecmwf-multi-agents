// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { load, type RuleSetItem, type Source } from "./load.ts";
import {
  approxTokens,
  budgetProblems,
  checkBudgets,
  checkReviewPolicy,
  expandPermissions,
  resolve,
  resolveHarness,
  reviewPolicyProblems,
  sizeTable,
} from "./resolve.ts";
import { GeneratorError } from "./util.ts";

// Fixtures are loose JSON on purpose.
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
      reads: [{ action: "shell", resource: "git log *" }],
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
        color: "#445566",
        permissions: [
          { action: "shell", resource: "*", effect: "deny" },
          { use: "reads", effect: "allow" },
          { action: "edit", resource: "*", effect: "deny" },
        ],
      },
      builder: {
        mode: "subagent",
        description: "Builds.",
        prompt: ["agents/builder.md", "fragments/helper.md"],
        budget: "helper",
        steps: 30,
        permissions: [
          { use: "writes", effect: "deny" },
          { action: "edit", resource: "notes/*", effect: "allow" },
        ],
      },
    },
    // Not in alphabetical order, to show manifest order is kept.
    commands: {
      zulu: { description: "Zulu.", agent: "scout", subtask: true, template: "commands/zulu.md" },
      alpha: { description: "Alpha.", agent: "lead", template: "commands/alpha.md" },
    },
    skills: {
      "skill-b": { description: "B.", body: "skills/skill-b/SKILL.md", hidden: true },
      "skill-a": { description: "A.", body: "skills/skill-a/SKILL.md" },
    },
  };
}

const MARKDOWN: Record<string, string> = {
  "agents/lead.md": "\n\nYou are lead.\r\n\r\nReview policy: auto\r\n\n",
  "agents/scout.md": "  You are scout.  \n",
  "agents/builder.md": "\nYou build.\n",
  "fragments/helper.md": "Helpers never ask.\n",
  "commands/zulu.md": "\nZulu: $ARGUMENTS\n\n",
  "commands/alpha.md": "Alpha.",
  "skills/skill-b/SKILL.md": "# B\n\nBody B.\n",
  "skills/skill-a/SKILL.md": "# A\n",
};

// Agents listed out of manifest order, and effort before model.
const PROFILES: Record<string, Json> = {
  default: {
    description: "Default.",
    agents: { scout: { model: "acme/small", effort: "low" }, lead: { effort: "max", model: "acme/big" } },
  },
  other: { description: "Other.", agents: { builder: { model: "acme/deep" } } },
};

async function sourceOf(
  options: { manifest?: Json; markdown?: Record<string, string>; profiles?: Record<string, Json> } = {},
): Promise<Source> {
  const root = await mkdtemp(path.join(tmpdir(), "ecmwf-multi-agents-resolve-"));
  roots.push(root);
  const files: Record<string, string> = {
    "src/manifest.jsonc": JSON.stringify(options.manifest ?? manifest(), null, 2),
    VERSION: "1.2.3\n",
  };
  for (const [id, profile] of Object.entries(options.profiles ?? PROFILES)) {
    files[`src/profiles/${id}.jsonc`] = JSON.stringify(profile, null, 2);
  }
  for (const [file, text] of Object.entries({ ...MARKDOWN, ...options.markdown })) files[`src/${file}`] = text;
  for (const [file, text] of Object.entries(files)) {
    const target = path.join(root, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, text);
  }
  return load(root);
}

function edited(change: (m: Json) => void): Json {
  const m = manifest();
  change(m);
  return m;
}

function problemsOf(run: () => unknown): string[] {
  try {
    run();
  } catch (error) {
    if (error instanceof GeneratorError) return [...error.problems];
    throw error;
  }
  throw new Error("expected a GeneratorError");
}

describe("rule sets", () => {
  test("expand in place into one rule per item, in order", () => {
    const ruleSets = new Map<string, RuleSetItem[]>([
      [
        "one",
        [
          { action: "shell", resource: "a *" },
          { action: "shell", resource: "b *" },
        ],
      ],
      ["two", [{ action: "edit", resource: "x/*" }]],
    ]);
    const rules = expandPermissions(
      [
        { action: "read", resource: "*", effect: "allow" },
        { use: "one", effect: "deny" },
        { action: "edit", resource: "*", effect: "ask" },
        { use: "two", effect: "allow" },
        { use: "one", effect: "ask" },
      ],
      ruleSets,
    );
    expect(rules).toEqual([
      { action: "read", resource: "*", effect: "allow" },
      { action: "shell", resource: "a *", effect: "deny" },
      { action: "shell", resource: "b *", effect: "deny" },
      { action: "edit", resource: "*", effect: "ask" },
      { action: "edit", resource: "x/*", effect: "allow" },
      { action: "shell", resource: "a *", effect: "ask" },
      { action: "shell", resource: "b *", effect: "ask" },
    ]);
    expect(() => expandPermissions([{ use: "three", effect: "deny" }], ruleSets)).toThrow('unknown rule set "three"');
  });

  test("expand in an agent's permissions", async () => {
    const harness = resolveHarness(await sourceOf());
    expect(harness.agents[0]?.permissions).toEqual([
      { action: "question", resource: "*", effect: "allow" },
      { action: "shell", resource: "git push *", effect: "ask" },
      { action: "shell", resource: "git commit *", effect: "ask" },
    ]);
  });
});

describe("agents", () => {
  test("an agent gets its own mode, prompt files, steps, color and rules, and is measured against its budget", async () => {
    const source = await sourceOf();
    const harness = resolveHarness(source);
    expect(harness.agents.find((agent) => agent.id === "builder")).toEqual({
      id: "builder",
      mode: "subagent",
      description: "Builds.",
      prompt: "You build.\n\nHelpers never ask.",
      steps: 30,
      permissions: [
        { action: "shell", resource: "git push *", effect: "deny" },
        { action: "shell", resource: "git commit *", effect: "deny" },
        { action: "edit", resource: "notes/*", effect: "allow" },
      ],
    });
    expect(harness.agents.find((agent) => agent.id === "scout")).toMatchObject({ color: "#445566", steps: 10 });
    const row = sizeTable(source, harness).find((candidate) => candidate.id === "builder");
    expect(row).toMatchObject({ budget: "helper", limit: 500, files: ["src/agents/builder.md", "src/fragments/helper.md"] });
  });

  test("agents may share a prompt file", async () => {
    const m = edited((m) => {
      m.agents.scout.prompt = ["agents/scout.md", "fragments/helper.md"];
    });
    const harness = resolveHarness(await sourceOf({ manifest: m }));
    expect(harness.agents.map((agent) => agent.prompt)).toEqual([
      "You are lead.\n\nReview policy: auto",
      "You are scout.\n\nHelpers never ask.",
      "You build.\n\nHelpers never ask.",
    ]);
  });

  test("prompt files are trimmed, get LF line endings and are joined by one blank line", async () => {
    const m = edited((m) => {
      m.agents.lead.prompt = ["agents/lead.md", "fragments/rules.md"];
    });
    const harness = resolveHarness(
      await sourceOf({ manifest: m, markdown: { "fragments/rules.md": "\r\n  Rule one.\r\nRule two.\r\n" } }),
    );
    expect(harness.agents[0]?.prompt).toBe("You are lead.\n\nReview policy: auto\n\nRule one.\nRule two.");
  });

  test("the default profile is baked in, its effort as the variant; agents it leaves out get no model", async () => {
    const harness = resolveHarness(await sourceOf());
    const models = harness.agents.map((agent) => [agent.id, agent.model, agent.variant]);
    expect(models).toEqual([
      ["lead", "acme/big", "max"],
      ["scout", "acme/small", "low"],
      ["builder", undefined, undefined],
    ]);
    expect("model" in (harness.agents[2] ?? {})).toBe(false);
    expect("effort" in (harness.agents[0] ?? {})).toBe(false);

    const other = resolveHarness(await sourceOf({ manifest: edited((m) => (m.defaultProfile = "other")) }));
    expect(other.agents.map((agent) => [agent.id, agent.model, agent.variant])).toEqual([
      ["lead", undefined, undefined],
      ["scout", undefined, undefined],
      ["builder", "acme/deep", undefined],
    ]);
  });
});

describe("harness", () => {
  test("keeps manifest order and reads commands and skills trimmed", async () => {
    const harness = resolveHarness(await sourceOf());
    expect(harness).toMatchObject({
      name: "test-harness",
      version: "1.2.3",
      defaultAgent: "lead",
      defaultProfile: "default",
      workDir: ".work",
      marker: "# managed by test",
    });
    expect(harness.agents.map((agent) => agent.id)).toEqual(["lead", "scout", "builder"]);
    expect(harness.commands).toEqual([
      { id: "zulu", description: "Zulu.", agent: "scout", subtask: true, template: "Zulu: $ARGUMENTS" },
      { id: "alpha", description: "Alpha.", agent: "lead", subtask: false, template: "Alpha." },
    ]);
    expect(harness.skills).toEqual([
      { id: "skill-b", description: "B.", body: "# B\n\nBody B.", hidden: true },
      { id: "skill-a", description: "A.", body: "# A", hidden: false },
    ]);
  });

  test("lists every profile by id, with agents in manifest order", async () => {
    const harness = resolveHarness(await sourceOf());
    expect(harness.profiles.map((profile) => profile.id)).toEqual(["default", "other"]);
    expect(Object.keys(harness.profiles[0]?.agents ?? {})).toEqual(["lead", "scout"]);
    expect(Object.keys(harness.profiles[0]?.agents.lead ?? {})).toEqual(["model", "effort"]);
    expect(harness.profiles[0]?.agents.lead).toEqual({ model: "acme/big", effort: "max" });
    expect(harness.profiles[1]).toEqual({ id: "other", description: "Other.", agents: { builder: { model: "acme/deep" } } });
  });
});

describe("budgets", () => {
  test("approxTokens is characters / 4, rounded up", () => {
    expect(approxTokens("")).toBe(0);
    expect(approxTokens("abc")).toBe(1);
    expect(approxTokens("abcd")).toBe(1);
    expect(approxTokens("abcde")).toBe(2);
    // Characters, not UTF-16 code units.
    expect(approxTokens("😀😀😀😀")).toBe(1);
  });

  // Sizes: lead 34 characters (9 tokens), scout 14 (4), builder 30 (8), zulu 16 (4),
  // alpha 6 (2), skill-b 12 (3), skill-a 3 (1).
  const tight = edited((m) => {
    m.budgets = { lead: 8, helper: 5, command: 3, skill: 2 };
  });

  test("the size table lists everything with its budget and never fails", async () => {
    const source = await sourceOf({ manifest: tight });
    const rows = sizeTable(source, resolveHarness(source));
    expect(rows.map((row) => [row.kind, row.id, row.characters, row.tokens, row.budget, row.limit])).toEqual([
      ["agent", "lead", 34, 9, "lead", 8],
      ["agent", "scout", 14, 4, "helper", 5],
      ["agent", "builder", 30, 8, "helper", 5],
      ["command", "zulu", 16, 4, "command", 3],
      ["command", "alpha", 6, 2, "command", 3],
      ["skill", "skill-b", 12, 3, "skill", 2],
      ["skill", "skill-a", 3, 1, "skill", 2],
    ]);
    expect(rows[3]?.key).toBe("commands.zulu.template");
  });

  test("the check lists every item over budget with its size and limit", async () => {
    const source = await sourceOf({ manifest: tight });
    const harness = resolveHarness(source);
    const expected = [
      "src/agents/lead.md: agents.lead.prompt: about 9 tokens (34 characters), over the lead budget of 8 tokens by 1",
      "src/agents/builder.md, src/fragments/helper.md: agents.builder.prompt: about 8 tokens (30 characters), over the helper budget of 5 tokens by 3",
      "src/commands/zulu.md: commands.zulu.template: about 4 tokens (16 characters), over the command budget of 3 tokens by 1",
      "src/skills/skill-b/SKILL.md: skills.skill-b.body: about 3 tokens (12 characters), over the skill budget of 2 tokens by 1",
    ];
    expect(budgetProblems(sizeTable(source, harness))).toEqual(expected);
    expect(problemsOf(() => checkBudgets(source, harness))).toEqual(expected);
    expect(problemsOf(() => resolve(source))).toEqual(expected);
  });

  test("items within budget pass", async () => {
    const source = await sourceOf();
    expect(checkBudgets(source, resolveHarness(source))).toHaveLength(7);
  });
});

describe("review policy line", () => {
  async function problemsFor(lead: string): Promise<string[]> {
    const source = await sourceOf({ markdown: { "agents/lead.md": lead } });
    return reviewPolicyProblems(source, resolveHarness(source));
  }

  test("exactly one line with auto passes", async () => {
    expect(await problemsFor("You are lead.\n\nReview policy: auto\n")).toEqual([]);
    const source = await sourceOf();
    expect(() => checkReviewPolicy(source, resolveHarness(source))).not.toThrow();
  });

  test("a missing line fails", async () => {
    expect(await problemsFor("You are lead.")).toEqual([
      'src/agents/lead.md: agents.lead.prompt: has no line "Review policy: auto"',
    ]);
    expect(await problemsFor("You are lead.\nReview policy: sometimes\n")).toEqual([
      'src/agents/lead.md: agents.lead.prompt: has no line "Review policy: auto"; "Review policy: sometimes" does not count: the line must be exactly "Review policy: <policy>"',
    ]);
  });

  test("a repeated line fails", async () => {
    expect(await problemsFor("Review policy: auto\n\nLater.\nReview policy: never\n")).toEqual([
      'src/agents/lead.md: agents.lead.prompt: has 2 "Review policy: ..." lines; it must have exactly one, which the plugin rewrites',
    ]);
  });

  test("a value other than auto fails", async () => {
    expect(await problemsFor("You are lead.\n\nReview policy: never")).toEqual([
      'src/agents/lead.md: agents.lead.prompt: has "Review policy: never"; the generated prompt must say "Review policy: auto", the default policy',
    ]);
  });

  test("resolve reports budget and review problems together", async () => {
    const m = edited((m) => {
      m.budgets.command = 3;
    });
    const source = await sourceOf({ manifest: m, markdown: { "agents/lead.md": "You are lead." } });
    expect(problemsOf(() => resolve(source))).toEqual([
      "src/commands/zulu.md: commands.zulu.template: about 4 tokens (16 characters), over the command budget of 3 tokens by 1",
      'src/agents/lead.md: agents.lead.prompt: has no line "Review policy: auto"',
    ]);
  });
});
