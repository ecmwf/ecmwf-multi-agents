// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type BuildOptions, build, FILES_LIST, platformFiles } from "./build.ts";
import { settingsSchema } from "./schema.ts";
import type { Emitter, OutputFile } from "./types.ts";
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
    ruleSets: { writes: [{ action: "shell", resource: "git push *" }] },
    agents: {
      lead: {
        mode: "primary",
        description: "Leads.",
        prompt: ["agents/lead.md"],
        budget: "lead",
        permissions: [{ use: "writes", effect: "ask" }],
      },
      scout: { mode: "subagent", description: "Looks.", prompt: ["agents/scout.md"], budget: "helper", steps: 10 },
      builder: { mode: "subagent", description: "Builds.", prompt: ["agents/builder.md", "fragments/helper.md"], budget: "helper" },
    },
    commands: { execute: { description: "Execute.", agent: "lead", template: "commands/execute.md" } },
    skills: { "test-plan": { description: "Plan format.", body: "skills/test-plan/SKILL.md", hidden: true } },
  };
}

const MARKDOWN: Record<string, string> = {
  "agents/lead.md": "You are lead.\n\nReview policy: auto\n",
  "agents/scout.md": "You are scout.\n",
  "agents/builder.md": "You build.\n",
  "fragments/helper.md": "Helpers never ask.\n",
  "commands/execute.md": "Execute: $ARGUMENTS\n",
  "skills/test-plan/SKILL.md": "# Plan\n",
};

// Agents out of manifest order and effort before model: the output must reorder both.
const PROFILES: Record<string, Json> = {
  default: {
    description: "Default.",
    agents: { scout: { model: "acme/small" }, lead: { effort: "max", model: "acme/big" } },
  },
  other: { description: "Other.", agents: {} },
};

async function fixture(options: { manifest?: Json; markdown?: Record<string, string> } = {}): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "ecmwf-multi-agents-build-"));
  roots.push(root);
  const files: Record<string, string> = {
    "src/manifest.jsonc": JSON.stringify(options.manifest ?? manifest(), null, 2),
    VERSION: "0.4.2\n",
  };
  for (const [id, profile] of Object.entries(PROFILES)) files[`src/profiles/${id}.jsonc`] = JSON.stringify(profile);
  for (const [file, text] of Object.entries({ ...MARKDOWN, ...options.markdown })) files[`src/${file}`] = text;
  for (const [file, text] of Object.entries(files)) await put(root, file, text);
  return root;
}

async function put(root: string, file: string, text: string): Promise<void> {
  const target = path.join(root, file);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, text);
}

/** Every file below `dir` with its content, keyed by relative path. */
async function tree(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  if (!existsSync(dir)) return out;
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const full = path.join(entry.parentPath, entry.name);
    out[path.relative(dir, full).split(path.sep).join("/")] = await readFile(full, "utf8");
  }
  return out;
}

const emitOne: Emitter = (harness) => [
  ...harness.agents.map((agent) => ({ path: `agents/${agent.id}.md`, content: `one ${agent.id}\n${agent.prompt}` })),
  ...harness.commands.map((command) => ({ path: `commands/${command.id}.md`, content: command.template })),
  ...harness.skills.map((skill) => ({ path: `skills/${skill.id}/SKILL.md`, content: skill.body })),
  // Byte order puts "Zeta.md" before "agents/"; a locale-aware sort would not.
  { path: "Zeta.md", content: "z" },
];
const emitTwo: Emitter = (harness) => harness.agents.map((agent) => ({ path: `agents/${agent.id}.md`, content: `two ${agent.id}` }));
const extras = async (): Promise<OutputFile[]> => [{ path: "plugins/test.js", content: "export default {};" }];

function options(root: string, more: Partial<BuildOptions> = {}): BuildOptions & { lines: string[] } {
  const lines: string[] = [];
  return { root, emitters: { p1: emitOne, p2: emitTwo }, extras, check: false, log: (line) => lines.push(line), lines, ...more };
}

async function failure(run: Promise<unknown>): Promise<string[]> {
  try {
    await run;
  } catch (error) {
    if (error instanceof GeneratorError) return [...error.problems];
    throw error;
  }
  throw new Error("expected a GeneratorError");
}

const SUPPORT = [
  "ecmwf-multi-agents/files.txt",
  "ecmwf-multi-agents/profiles/default.json",
  "ecmwf-multi-agents/profiles/other.json",
  "ecmwf-multi-agents/schema.json",
];

describe("output", () => {
  test("every platform gets its emitter's files, the extras and the support files", async () => {
    const root = await fixture();
    const result = await build(options(root));
    const one = await tree(path.join(root, "dist/p1"));
    const two = await tree(path.join(root, "dist/p2"));
    expect(Object.keys(one).sort()).toEqual(
      [
        "Zeta.md",
        "agents/builder.md",
        "agents/lead.md",
        "agents/scout.md",
        "commands/execute.md",
        "plugins/test.js",
        "skills/test-plan/SKILL.md",
        ...SUPPORT,
      ].sort(),
    );
    expect(Object.keys(two).sort()).toEqual(
      ["agents/builder.md", "agents/lead.md", "agents/scout.md", "plugins/test.js", ...SUPPORT].sort(),
    );
    expect(result.harness.version).toBe("0.4.2");
    expect(one["plugins/test.js"]).toBe("export default {};\n");
    expect(two["plugins/test.js"]).toBe("export default {};\n");
    expect(one["agents/builder.md"]).toBe("one builder\nYou build.\n\nHelpers never ask.\n");
    expect(two["agents/lead.md"]).toBe("two lead\n");
    expect(one["ecmwf-multi-agents/schema.json"]).toBe(`${JSON.stringify(settingsSchema(result.harness), null, 2)}\n`);
    expect(two["ecmwf-multi-agents/schema.json"]).toBe(one["ecmwf-multi-agents/schema.json"]);
    expect(result.platforms.map((platform) => [platform.platform, platform.files.length, platform.written.length])).toEqual([
      ["p1", 11, 11],
      ["p2", 8, 8],
    ]);
  });

  test("profiles are written with keys in a fixed order, one key per line", async () => {
    const root = await fixture();
    await build(options(root));
    const text = await readFile(path.join(root, "dist/p1/ecmwf-multi-agents/profiles/default.json"), "utf8");
    expect(text).toBe(
      [
        "{",
        '  "id": "default",',
        '  "description": "Default.",',
        '  "agents": {',
        '    "lead": {',
        '      "model": "acme/big",',
        '      "effort": "max"',
        "    },",
        '    "scout": {',
        '      "model": "acme/small"',
        "    }",
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    expect(await readFile(path.join(root, "dist/p2/ecmwf-multi-agents/profiles/other.json"), "utf8")).toBe(
      '{\n  "id": "other",\n  "description": "Other.",\n  "agents": {}\n}\n',
    );
  });

  test("files.txt lists every file of the platform in byte order, itself included", async () => {
    const root = await fixture();
    await build(options(root));
    for (const platform of ["p1", "p2"]) {
      const files = await tree(path.join(root, "dist", platform));
      const listed = files[FILES_LIST] ?? "";
      expect(listed.endsWith("\n")).toBe(true);
      const lines = listed.slice(0, -1).split("\n");
      expect(lines).toContain(FILES_LIST);
      expect([...lines].sort()).toEqual(Object.keys(files).sort());
      expect(lines).toEqual([...lines].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))));
    }
    const one = (await readFile(path.join(root, "dist/p1", FILES_LIST), "utf8")).split("\n");
    expect(one.slice(0, 2)).toEqual(["Zeta.md", "agents/builder.md"]);
  });

  test("content gets LF line endings and exactly one trailing newline", async () => {
    const root = await fixture();
    const emit: Emitter = () => [
      { path: "crlf.md", content: "a\r\nb\r\n\r\n\n" },
      { path: "bare.md", content: "no newline" },
      { path: "cr.md", content: "x\ry" },
      { path: "empty.md", content: "" },
    ];
    await build(options(root, { emitters: { p1: emit }, extras: async () => [{ path: "x.js", content: "x;\r\n\r\n" }] }));
    const files = await tree(path.join(root, "dist/p1"));
    expect(files["crlf.md"]).toBe("a\nb\n");
    expect(files["bare.md"]).toBe("no newline\n");
    expect(files["cr.md"]).toBe("x\ny\n");
    expect(files["empty.md"]).toBe("\n");
    expect(files["x.js"]).toBe("x;\n");
  });

  test("is deterministic", async () => {
    const first = await fixture();
    const second = await fixture();
    await build(options(first));
    await build(options(second));
    const again = await build(options(first));
    expect(again.platforms.map((platform) => [platform.written, platform.removed])).toEqual([
      [[], []],
      [[], []],
    ]);
    expect(await tree(path.join(first, "dist"))).toEqual(await tree(path.join(second, "dist")));
  });

  test("logs the size of every agent, command and skill and the files per platform", async () => {
    const root = await fixture();
    const run = options(root);
    await build(run);
    expect(run.lines).toEqual([
      "kind     id        tokens budget",
      "agent    lead           9   1000 lead",
      "agent    scout          4    500 helper",
      "agent    builder        8    500 helper",
      "command  execute        5    300 command",
      "skill    test-plan      2    400 skill",
      "dist/p1: 11 files (11 written, 0 removed)",
      "dist/p2: 8 files (8 written, 0 removed)",
    ]);
  });
});

describe("check mode", () => {
  test("passes when dist/ is current and writes nothing", async () => {
    const root = await fixture();
    await build(options(root));
    const before = await tree(path.join(root, "dist"));
    const run = options(root, { check: true });
    const result = await build(run);
    expect(result.platforms.every((platform) => platform.written.length === 0 && platform.removed.length === 0)).toBe(true);
    expect(run.lines.slice(-2)).toEqual(["dist/p1: 11 files, up to date", "dist/p2: 8 files, up to date"]);
    expect(await tree(path.join(root, "dist"))).toEqual(before);
  });

  test("lists missing, changed and extra files per platform and leaves them alone", async () => {
    const root = await fixture();
    await build(options(root));
    await writeFile(path.join(root, "dist/p1/agents/lead.md"), "edited by hand\n");
    await rm(path.join(root, "dist/p2/agents/scout.md"));
    await put(root, "dist/p1/extra/file.md", "x");
    await put(root, "dist/p2/stale.txt", "x");
    const problems = await failure(build(options(root, { check: true })));
    expect(problems).toEqual([
      "dist/p1: changed agents/lead.md",
      "dist/p1: extra extra/file.md",
      "dist/p2: missing agents/scout.md",
      "dist/p2: extra stale.txt",
    ]);
    expect(await readFile(path.join(root, "dist/p1/agents/lead.md"), "utf8")).toBe("edited by hand\n");
    expect(existsSync(path.join(root, "dist/p2/stale.txt"))).toBe(true);
    expect(existsSync(path.join(root, "dist/p2/agents/scout.md"))).toBe(false);
  });

  test("fails on a missing dist/ without creating it", async () => {
    const root = await fixture();
    const problems = await failure(build(options(root, { check: true })));
    expect(problems).toHaveLength(19);
    expect(problems[0]).toBe("dist/p1: missing Zeta.md");
    expect(existsSync(path.join(root, "dist"))).toBe(false);
  });

  test("a link in place of a file counts as changed", async () => {
    const root = await fixture();
    await build(options(root));
    const target = path.join(root, "dist/p1/agents/lead.md");
    await put(root, "copy.md", await readFile(target, "utf8"));
    await rm(target);
    await symlink(path.join(root, "copy.md"), target);
    expect(await failure(build(options(root, { check: true })))).toEqual(["dist/p1: changed agents/lead.md"]);
  });
});

describe("cleanup", () => {
  test("removes stale files and empty directories, and leaves other platforms alone", async () => {
    const root = await fixture();
    await put(root, "dist/p1/old/deep/stale.md", "x");
    await put(root, "dist/p1/agents/gone.md", "x");
    await mkdir(path.join(root, "dist/p1/empty/inner"), { recursive: true });
    await put(root, "dist/other/keep.md", "keep");
    const result = await build(options(root));
    expect(result.platforms[0]?.removed).toEqual(["agents/gone.md", "old/deep/stale.md"]);
    expect(existsSync(path.join(root, "dist/p1/old"))).toBe(false);
    expect(existsSync(path.join(root, "dist/p1/empty"))).toBe(false);
    expect(existsSync(path.join(root, "dist/p1/agents/lead.md"))).toBe(true);
    expect(await readFile(path.join(root, "dist/other/keep.md"), "utf8")).toBe("keep");
    expect(Object.keys(await tree(path.join(root, "dist/p1"))).sort()).toEqual(
      ((await readFile(path.join(root, "dist/p1", FILES_LIST), "utf8")).trim().split("\n")).sort(),
    );
  });

  test("a stale file or directory never blocks a path the build needs", async () => {
    const root = await fixture();
    await put(root, "dist/p1/plugins", "a file where a directory belongs");
    await put(root, "dist/p1/agents/lead.md/inside.md", "a directory where a file belongs");
    await build(options(root));
    expect((await lstat(path.join(root, "dist/p1/agents/lead.md"))).isFile()).toBe(true);
    expect(await readFile(path.join(root, "dist/p1/plugins/test.js"), "utf8")).toBe("export default {};\n");
  });

  test("a link is replaced, never written through", async () => {
    const root = await fixture();
    await put(root, "outside.md", "original\n");
    await mkdir(path.join(root, "dist/p1/agents"), { recursive: true });
    await symlink(path.join(root, "outside.md"), path.join(root, "dist/p1/agents/lead.md"));
    await build(options(root));
    expect(await readFile(path.join(root, "outside.md"), "utf8")).toBe("original\n");
    const target = path.join(root, "dist/p1/agents/lead.md");
    expect((await lstat(target)).isFile()).toBe(true);
    expect(await readFile(target, "utf8")).toBe("one lead\nYou are lead.\n\nReview policy: auto\n");
  });
});

describe("paths", () => {
  test("unsafe, duplicate and clashing paths are rejected before anything is written", async () => {
    const root = await fixture();
    const emit: Emitter = () =>
      [
        "../evil.md",
        "/abs.md",
        "a\\b.md",
        "a/./b.md",
        "a//b.md",
        "",
        ".hidden",
        "-dash.md",
        "has space.md",
        "dup.md",
        "dup.md",
        "plugins/test.js",
        FILES_LIST,
        "Case.md",
        "case.md",
        "file",
        "file/child.md",
      ].map((p) => ({ path: p, content: "x" }));
    const problems = await failure(build(options(root, { emitters: { p1: emit } })));
    expect(problems).toEqual([
      'p1: emitter p1: path "../evil.md" has a ".." segment',
      'p1: emitter p1: path "/abs.md" is absolute',
      'p1: emitter p1: path "a\\\\b.md" uses "\\"; separate segments with "/"',
      'p1: emitter p1: path "a/./b.md" has a "." segment',
      'p1: emitter p1: path "a//b.md" has an empty segment',
      'p1: emitter p1: path "" is empty',
      'p1: emitter p1: path ".hidden" has the segment ".hidden"; use letters, digits, ".", "_" and "-", not starting with "." or "-"',
      'p1: emitter p1: path "-dash.md" has the segment "-dash.md"; use letters, digits, ".", "_" and "-", not starting with "." or "-"',
      'p1: emitter p1: path "has space.md" has the segment "has space.md"; use letters, digits, ".", "_" and "-", not starting with "." or "-"',
      'p1: path "dup.md" is written twice by emitter p1',
      'p1: emitter p1: path "case.md" differs from "Case.md" only in case',
      'p1: path "plugins/test.js" is written by both emitter p1 and extras',
      'p1: path "ecmwf-multi-agents/files.txt" is written by both emitter p1 and support files',
      'p1: path "file" is a file, but "file/child.md" needs it as a directory',
    ]);
    expect(existsSync(path.join(root, "dist"))).toBe(false);
  });

  test("extras that are not files are rejected", async () => {
    const root = await fixture();
    const bad = async () => [{ path: 1, content: "x" }] as unknown as OutputFile[];
    expect(await failure(build(options(root, { emitters: { p1: emitTwo }, extras: bad })))).toEqual([
      'p1: extras: {"path":1,"content":"x"} is not a {path, content} file',
    ]);
  });

  test("platform names must be single safe directory names", async () => {
    const root = await fixture();
    expect(await failure(build(options(root, { emitters: { "../up": emitTwo, "a/b": emitTwo } })))).toEqual([
      'platform "../up" has a ".." segment',
      'platform "a/b" must be a single directory name',
    ]);
  });

  test("platformFiles adds files.txt and sorts by byte order", () => {
    const files = platformFiles("p", [
      {
        origin: "test",
        files: [
          { path: "a.md", content: "a" },
          { path: "Z.md", content: "Z" },
        ],
      },
    ]);
    expect(files.map((file) => file.path)).toEqual(["Z.md", "a.md", FILES_LIST]);
    expect(files.at(-1)?.content).toBe(`Z.md\na.md\n${FILES_LIST}\n`);
  });

  test("files.txt leaves out the central install's template", () => {
    const files = platformFiles("p", [
      {
        origin: "test",
        files: [
          { path: "a.md", content: "a" },
          { path: "central/opencode.json", content: "{}" },
        ],
      },
    ]);
    expect(files.map((file) => file.path)).toEqual(["a.md", "central/opencode.json", FILES_LIST]);
    expect(files.find((file) => file.path === FILES_LIST)?.content).toBe(`a.md\n${FILES_LIST}\n`);
  });
});

describe("checks", () => {
  test("a prompt over budget stops the build before anything is written", async () => {
    const m = manifest();
    m.budgets.helper = 5;
    const root = await fixture({ manifest: m });
    const run = options(root);
    const problems = await failure(build(run));
    expect(problems).toEqual([
      "src/agents/builder.md, src/fragments/helper.md: agents.builder.prompt: about 8 tokens (30 characters), over the helper budget of 5 tokens by 3",
    ]);
    expect(run.lines).toContain("agent    builder        8      5 helper  OVER");
    expect(existsSync(path.join(root, "dist"))).toBe(false);
  });

  test("a missing review policy line stops the build", async () => {
    const root = await fixture({ markdown: { "agents/lead.md": "You are lead." } });
    expect(await failure(build(options(root)))).toEqual([
      'src/agents/lead.md: agents.lead.prompt: has no line "Review policy: auto"',
    ]);
  });

  test("a VERSION that is not one version line stops the build before anything is written", async () => {
    const root = await fixture();
    await writeFile(path.join(root, "VERSION"), "v0.4.2\n");
    expect(await failure(build(options(root)))).toEqual(['VERSION: "v0.4.2" starts with "v"; write the version without it, as 0.4.2']);
    expect(existsSync(path.join(root, "dist"))).toBe(false);
  });

  test("source problems stop the build", async () => {
    const m = manifest();
    m.agents.lead.extra = true;
    const root = await fixture({ manifest: m });
    expect(await failure(build(options(root)))).toEqual([
      "src/manifest.jsonc: agents.lead.extra: unknown key; allowed keys are mode, description, prompt, budget, steps, color and permissions",
    ]);
  });
});

test("the command line rejects unknown arguments with exit code 1", () => {
  const run = Bun.spawnSync([process.execPath, path.join(import.meta.dir, "build.ts"), "--force"], { stderr: "pipe", stdout: "pipe" });
  expect(run.exitCode).toBe(1);
  expect(run.stderr.toString()).toContain("usage: bun tools/build.ts [--check]");
});
