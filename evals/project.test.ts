// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

// Profiles, configuration, the eval login's location, sandboxes and every case's setup on the
// fixture. Uses git and python3; no network and no opencode.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CASES, readingsCsv, UNITS_BUG } from "./cases.ts";
import { checkEvalLogin, evalLoginDb, gitWorkTreeOf, importLogin, loginDbProblem, loginEnv, pipeEnv } from "./login.ts";
import {
  applySetup,
  changedBetween,
  createBox,
  exec,
  HIDDEN,
  linkOpencode,
  listProjectFiles,
  loadProfile,
  loginPlugins,
  opencodeConfig,
  parseProfile,
  parseVersion,
  profileProviders,
  PROJECT_CONFIG_NAMES,
  projectConfigFrom,
  projectDiff,
  readProjectFile,
  removeBox,
  resolveBinary,
  sandboxParentProblem,
  sandboxPath,
  snapshot,
} from "./project.ts";
import type { Box } from "./project.ts";
import { runCase } from "./runner.ts";

const boxes: Box[] = [];
const box = () => {
  const made = createBox();
  boxes.push(made);
  return made;
};
afterAll(() => {
  for (const made of boxes) if (existsSync(made.dir)) removeBox(made);
});

describe("profiles and configuration", () => {
  const profile = parseProfile("default", {
    agents: {
      lead: { model: "anthropic/claude-opus-5-5", variant: "xhigh" },
      scout: { model: "anthropic/claude-sonnet-5-5", effort: "medium" },
      reviewer: { model: "github-copilot/gpt-6.1-sol", variant: "medium" },
      odd: { model: 3 },
    },
  });

  test("variant or effort, providers from the models", () => {
    expect(profile.agents.scout).toEqual({ model: "anthropic/claude-sonnet-5-5", variant: "medium" });
    expect(profile.agents.odd).toEqual({});
    expect(profileProviders(profile)).toEqual(["anthropic", "github-copilot"]);
    expect(parseProfile("inherit", { agents: {} })).toEqual({ name: "inherit", agents: {} });
  });

  test("profiles come from the opencode 2 files", () => {
    expect(loadProfile("default").agents.lead).toEqual({ model: "anthropic/claude-opus-5-5", variant: "xhigh" });
    expect(() => loadProfile("../x")).toThrow("invalid profile name");
  });

  test("harness config, in opencode 2 keys: only the profile's providers, lead's model as session model, sharing and updates off", () => {
    expect(opencodeConfig("harness", profile)).toEqual({
      share: "disabled",
      update: "disable",
      policies: [
        { action: "provider.use", resource: "*", effect: "deny" },
        { action: "provider.use", resource: "anthropic", effect: "allow" },
        { action: "provider.use", resource: "github-copilot", effect: "allow" },
      ],
      model: "anthropic/claude-opus-5-5",
    });
  });

  test("extra plugins from the environment go into the plugins list", () => {
    expect(loginPlugins({ ECMWF_MULTI_AGENTS_EVAL_PLUGINS: " one@1.0, two  three " })).toEqual(["one@1.0", "two", "three"]);
    expect(loginPlugins({})).toEqual([]);
    expect(opencodeConfig("harness", profile, {}, ["one@1.0"]).plugins).toEqual(["one@1.0"]);
    expect(opencodeConfig("harness", profile).plugins).toBeUndefined();
  });

  test("baseline config: the build agent on lead's model and effort", () => {
    expect(opencodeConfig("baseline", profile)).toMatchObject({
      model: "anthropic/claude-opus-5-5",
      agents: { build: { model: "anthropic/claude-opus-5-5#xhigh" } },
    });
    expect(opencodeConfig("baseline", parseProfile("inherit", {}), { model: "mock/m1" })).toMatchObject({ model: "mock/m1", agents: { build: {} } });
  });
});

describe("opencode binary", () => {
  test("versions in either output format", () => {
    expect(parseVersion("opencode v2.0.28\n")).toBe("2.0.28");
    expect(parseVersion("2.0.29")).toBe("2.0.29");
    expect(parseVersion("1.18.35")).toBe("1.18.35");
    expect(parseVersion("not a version")).toBe("");
  });

  test("a bare name is looked up on PATH, a path must exist", () => {
    expect(resolveBinary("sh")).toMatch(/\/sh$/);
    expect(resolveBinary("/nonexistent/opencode")).toBeUndefined();
    expect(resolveBinary("no-such-binary-for-evals")).toBeUndefined();
  });

  test("the sandbox links the binary in as opencode, first on PATH; removing the sandbox keeps the binary", () => {
    const made = box();
    const target = path.join(made.dir, "..", `${path.basename(made.dir)}-opencode-2.0.28`);
    writeFileSync(target, "#!/bin/sh\n", { mode: 0o755 });
    try {
      const link = linkOpencode(made, target);
      expect(link).toBe(path.join(made.dir, "bin", "opencode"));
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readlinkSync(link)).toBe(target);
      expect(sandboxPath(made).split(":")[0]).toBe(path.join(made.dir, "bin"));
      removeBox(made);
      expect(existsSync(target)).toBe(true);
    } finally {
      rmSync(target, { force: true });
    }
  });
});

describe("the eval login", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "eval-login-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("its own database in a folder of its own in the data folder, never opencode's nor the checkout's", () => {
    expect(evalLoginDb({}, "/home/someone")).toBe("/home/someone/.local/share/ecmwf-multi-agents-evals/eval-login.db");
    expect(evalLoginDb({ XDG_DATA_HOME: "/data" }, "/home/someone")).toBe("/data/ecmwf-multi-agents-evals/eval-login.db");
    // The README suggests ~/.local/share/ecmwf-multi-agents for the checkout: the login never goes there.
    expect(path.dirname(evalLoginDb({}, "/home/someone"))).not.toBe("/home/someone/.local/share/ecmwf-multi-agents");
    expect(evalLoginDb({ ECMWF_MULTI_AGENTS_EVAL_LOGIN_DB: "/elsewhere/login.db", XDG_DATA_HOME: "/data" }, "/home/someone")).toBe("/elsewhere/login.db");
  });

  test("a login database inside a git working tree is refused, whichever way it is named", () => {
    const checkout = "/home/someone/.local/share/ecmwf-multi-agents";
    const exists = (file: string) => file === `${checkout}/.git`;
    expect(gitWorkTreeOf(`${checkout}/eval-login.db`, exists)).toBe(checkout);
    expect(gitWorkTreeOf(`${checkout}/evals/x/login.db`, exists)).toBe(checkout);
    expect(gitWorkTreeOf("/home/someone/.local/share/ecmwf-multi-agents-evals/eval-login.db", exists)).toBeUndefined();
    expect(loginDbProblem(`${checkout}/eval-login.db`, exists)).toContain("git working tree");
    // This repository is a git working tree: a login named inside it is refused before any use.
    const inside = checkEvalLogin({ ECMWF_MULTI_AGENTS_EVAL_LOGIN_DB: path.join(import.meta.dir, "eval-login.db") }, "/nonexistent-home");
    expect(inside.ok).toBe(false);
    if (!inside.ok) expect(inside.message).toContain("git working tree");
  });

  test("the login and the export and import pipe never read project config", () => {
    const env = loginEnv("/data/eval-login.db", { OPENCODE_CONFIG: "/x/opencode.json", OPENCODE_DISABLE_PROJECT_CONFIG: "0", OTHER: "kept" });
    expect(env).toMatchObject({ OPENCODE_DISABLE_PROJECT_CONFIG: "1", OPENCODE_DB: "/data/eval-login.db", OTHER: "kept" });
    expect(env.OPENCODE_CONFIG).toBeUndefined();
    expect(pipeEnv({ PATH: "/bin", OPENCODE_DISABLE_PROJECT_CONFIG: "0" }, "/data/eval-login.db", "secret")).toEqual({
      PATH: "/bin",
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      EVAL_LOGIN_DB: "/data/eval-login.db",
      EVAL_SERVER_PASSWORD: "secret",
    });
  });

  test("both sides of the pipe run with project config off, each with only its own secret", async () => {
    const made = box();
    const record = path.join(dir, "pipe.txt");
    const fake = path.join(dir, "fake-opencode");
    // Records, for each side, the switch and whether each secret is visible to it.
    writeFileSync(
      fake,
      [
        "#!/bin/sh",
        'side=$2; [ "$side" = import ] && cat >/dev/null',
        'echo "$side project=${OPENCODE_DISABLE_PROJECT_CONFIG:-unset} db=${OPENCODE_DB:+yes} password=${OPENCODE_PASSWORD:+yes} cwd=$(pwd)" >>"$RECORD"',
        '[ "$side" = export ] && echo "[]"',
        "exit 0",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    await importLogin(made, fake, "/data/eval-login.db", { url: "http://127.0.0.1:9", password: "secret" }, { PATH: process.env.PATH ?? "/bin", RECORD: record });
    const lines = readFileSync(record, "utf8").trim().split("\n").sort();
    expect(lines).toEqual([
      `export project=1 db=yes password= cwd=${path.join(made.dir, "login")}`,
      `import project=1 db= password=yes cwd=${path.join(made.dir, "login")}`,
    ].sort());
  });

  test("a missing login says to run make eval-login", () => {
    const missing = checkEvalLogin({ XDG_DATA_HOME: dir }, "/nonexistent-home");
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.message).toContain("make eval-login");
    const db = path.join(dir, "login.db");
    writeFileSync(db, "");
    expect(checkEvalLogin({ ECMWF_MULTI_AGENTS_EVAL_LOGIN_DB: db }, "/nonexistent-home")).toEqual({ ok: true, path: db });
  });
});

describe("project config above the sandbox", () => {
  const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), "eval-above-")));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  test("the names are those opencode 2 reads from every folder up to the root", () => {
    expect([...PROJECT_CONFIG_NAMES].sort()).toEqual([".agents", ".claude", ".opencode", "opencode.json", "opencode.jsonc"]);
  });

  test("every name in the folder and every folder above it counts, nearest first, up to the root", () => {
    const files = new Set(["/opencode.json", "/tmp/.claude", "/tmp/.agents", "/tmp/x/.opencode", "/tmp/x/opencode.jsonc", "/tmp/x/y/README.md"]);
    const exists = (file: string) => files.has(file);
    expect(projectConfigFrom("/tmp/x/y", exists)).toEqual(["/tmp/x/.opencode", "/tmp/x/opencode.jsonc", "/tmp/.claude", "/tmp/.agents", "/opencode.json"]);
    expect(projectConfigFrom("/srv/clean", exists)).toEqual(["/opencode.json"]);
    expect(projectConfigFrom("/srv/clean", () => false)).toEqual([]);
    expect(sandboxParentProblem("/srv/clean", () => false)).toBeUndefined();
  });

  test("the message names the file and suggests TMPDIR", () => {
    const problem = sandboxParentProblem("/tmp", (file) => file === "/tmp/opencode.json");
    expect(problem).toContain("/tmp/opencode.json");
    expect(problem).toContain("TMPDIR");
  });

  test("on a real tree: a file or folder above counts, a dangling link too, the folders below do not", () => {
    const top = path.join(scratch, "top");
    const sandboxes = path.join(top, "a", "b");
    mkdirSync(path.join(sandboxes, "ecmwf-eval-x", "project", ".opencode"), { recursive: true });
    writeFileSync(path.join(sandboxes, "ecmwf-eval-x", "project", "opencode.json"), "{}\n");
    expect(projectConfigFrom(sandboxes).filter((file) => file.startsWith(scratch))).toEqual([]);
    mkdirSync(path.join(top, "a", ".claude"));
    writeFileSync(path.join(top, "opencode.jsonc"), "{}\n");
    symlinkSync(path.join(scratch, "missing"), path.join(sandboxes, ".agents"));
    expect(projectConfigFrom(sandboxes).filter((file) => file.startsWith(scratch))).toEqual([path.join(sandboxes, ".agents"), path.join(top, "a", ".claude"), path.join(top, "opencode.jsonc")]);
  });

  test("a run refuses to start opencode under such a folder and removes its sandbox", async () => {
    const tmp = path.join(scratch, "tmp");
    mkdirSync(tmp);
    writeFileSync(path.join(scratch, "opencode.json"), '{"plugins": ["someone-elses-plugin"]}\n');
    const saved = process.env.TMPDIR;
    process.env.TMPDIR = tmp;
    try {
      const record = await runCase(CASES[0]!, {
        variant: "baseline",
        repeat: 1,
        profile: parseProfile("inherit", {}),
        opencode: "/nonexistent/opencode",
        opencodeVersion: "2.0.29",
        timeoutMs: 1_000,
        auth: { kind: "none" },
      });
      expect(record.status).toBe("error");
      expect(record.error).toContain(path.join(scratch, "opencode.json"));
      expect(readdirSync(tmp)).toEqual([]);
    } finally {
      if (saved === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = saved;
    }
  });
});

describe("sandbox and project", () => {
  test("a fresh project with a fixed identity gives the same commit every time", () => {
    const first = box();
    const second = box();
    const a = applySetup(first, []);
    const b = applySetup(second, []);
    expect(a).toMatch(/^[0-9a-f]{40}$/);
    expect(a).toBe(b);
    expect(exec(["git", "log", "-1", "--format=%an <%ae> %cI"], { cwd: first.project }).output.trim()).toBe("Eval User <eval.user@example.invalid> 2026-10-01T09:00:00Z");
    expect(first.dir.startsWith(path.resolve(tmpdir()))).toBe(true);
  });

  test("snapshots see added, changed and removed files but not caches", () => {
    const made = box();
    applySetup(made, []);
    const before = snapshot(made.project);
    writeFileSync(path.join(made.project, "README.md"), "changed\n");
    writeFileSync(path.join(made.project, "new.txt"), "new\n");
    rmSync(path.join(made.project, "AGENTS.md"));
    exec(["python3", "-c", "import compileall; compileall.compile_dir('stations', quiet=1)"], { cwd: made.project, env: { PYTHONDONTWRITEBYTECODE: "" } });
    expect(changedBetween(before, snapshot(made.project))).toEqual(["AGENTS.md", "README.md", "new.txt"]);
    expect(projectDiff(made.project, exec(["git", "rev-parse", "HEAD"], { cwd: made.project }).output.trim())).toContain("new.txt");
  });

  test("setup steps refuse paths outside the project and text that is not there once", () => {
    expect(() => applySetup(box(), [{ kind: "write", path: "../outside.txt", content: "x" }])).toThrow("outside the project");
    expect(() => applySetup(box(), [{ kind: "replace", path: "README.md", find: "no such text", replace: "y" }])).toThrow("found it 0 times");
    expect(readProjectFile(box().project, "../../etc/passwd")).toBeUndefined();
  });
});

describe("every case's setup on the fixture", () => {
  const unittest = (cwd: string) => exec(["python3", "-m", "unittest", "-q"], { cwd });
  const hidden = (cwd: string, id: string) => exec(["python3", "-m", "unittest", "discover", "-s", path.join(HIDDEN, id), "-t", path.join(HIDDEN, id), "-p", "test_*.py"], { cwd });

  for (const item of CASES) {
    test(item.id, () => {
      const made = box();
      const head = applySetup(made, item.setup);
      expect(head).toMatch(/^[0-9a-f]{40}$/);
      const tests = unittest(made.project);
      // The units bug of the review cases and of tester-break breaks the existing tests on
      // purpose: the reviewer or the tester can find it.
      expect(tests.code).toBe(UNITS_BUG.every((step) => item.setup.includes(step)) ? 1 : 0);
      // A case may reuse another case's hidden tests; the check names the folder it runs.
      const hiddenCheck = item.checks.find((check): check is typeof check & { folder: string } => check.id === "hidden-tests" && "folder" in check);
      if (hiddenCheck) {
        expect(existsSync(path.join(HIDDEN, hiddenCheck.folder))).toBe(true);
        expect(hidden(made.project, hiddenCheck.folder).code).not.toBe(0);
      }
      if (made.remote) {
        expect(exec(["git", "--git-dir", made.remote, "rev-parse", "main"], { cwd: made.dir }).output.trim()).toBe(head);
        expect(exec(["git", "status", "--porcelain"], { cwd: made.project }).output.trim()).toBe("M README.md");
      }
    });
  }

  test("bug-fix: the hidden tests pass once the seeded bug is reverted", () => {
    const made = box();
    applySetup(made, CASES.find((item) => item.id === "bug-fix")!.setup);
    const file = path.join(made.project, "stations", "units.py");
    const text = readFileSync(file, "utf8");
    const at = text.lastIndexOf('    "K": kelvin_to_celsius,');
    writeFileSync(file, `${text.slice(0, at)}    "K": celsius_to_kelvin,${text.slice(at + '    "K": kelvin_to_celsius,'.length)}`);
    expect(hidden(made.project, "bug-fix").code).toBe(0);
  });

  test("progress: the seeded plans are excluded from git, the done plan is the newest", () => {
    const made = box();
    applySetup(made, CASES.find((item) => item.id === "progress")!.setup);
    expect(exec(["git", "status", "--porcelain"], { cwd: made.project }).output.trim()).toBe("");
    expect(listProjectFiles(made.project, ".ecmwf-multi-agents/plans")).toEqual([".ecmwf-multi-agents/plans/json-output.md", ".ecmwf-multi-agents/plans/kelvin-output.md"]);
    const ls = exec(["ls", "-t", ".ecmwf-multi-agents/plans"], { cwd: made.project }).output.trim().split("\n");
    expect(ls).toEqual(["kelvin-output.md", "json-output.md"]);
  });
});

describe("designer-limit", () => {
  test("switches the designer on with a low step limit, and checks that lead continues it rather than designing itself", () => {
    const item = CASES.find((candidate) => candidate.id === "designer-limit")!;
    const settings = item.setup.find((step) => step.kind === "write" && step.path === ".opencode/ecmwf-multi-agents.jsonc");
    expect(settings?.kind === "write" && JSON.parse(settings.content)).toEqual({ agents: { designer: { enabled: true, steps: 12 } } });
    expect(item.checks.map((check) => check.id)).toEqual(["designer-sessions", "designer-no-errors", "designer-continued", "spec", "lead-not-written", "no-changes"]);
    expect(item.baseline).toBe(false);
  });
});

describe("designer-limit-twice", () => {
  test("gives the designer a limit low enough to reach twice, and checks that lead offers a higher one and the project file gets it", () => {
    const item = CASES.find((candidate) => candidate.id === "designer-limit-twice")!;
    const settings = item.setup.find((step) => step.kind === "write" && step.path === ".opencode/ecmwf-multi-agents.jsonc");
    expect(settings?.kind === "write" && JSON.parse(settings.content)).toEqual({ agents: { designer: { enabled: true, steps: 6 } } });
    expect(item.checks.map((check) => check.id)).toEqual(["designer-no-errors", "designer-continued", "steps-offer", "designer-steps-raised", "no-changes"]);
    const changes = item.checks.find((check) => check.id === "no-changes")!;
    const run = (changedFiles: string[]) => changes.run({ changedFiles } as never);
    expect(run([".opencode/ecmwf-multi-agents.jsonc", ".ecmwf-multi-agents/design/x/spec.md"])).toMatchObject({ pass: true });
    expect(run(["stations/units.py"])).toMatchObject({ pass: false });
    expect(item.baseline).toBe(false);
  });
});

describe("data-question", () => {
  test("checks that the computation was kept as a script in the data scientist's folder", () => {
    const item = CASES.find((candidate) => candidate.id === "data-question")!;
    expect(item.checks.map((check) => check.id)).toEqual(["data-scientist-sessions", "statistics", "data-script", "not-read-whole", "no-changes"]);
    const script = item.checks.find((check) => check.id === "data-script")!;
    const run = (changedFiles: string[]) => script.run({ changedFiles } as never);
    expect(run([".ecmwf-multi-agents/data/station-means/means.py", ".ecmwf-multi-agents/data/station-means/sources.md"])).toMatchObject({ pass: true });
    expect(run([".ecmwf-multi-agents/data/station-means/sources.md"])).toMatchObject({ pass: false });
    expect(run([])).toMatchObject({ pass: false });
  });

  test("accepts a negative mean written with a hyphen or a typographic minus sign, never without its sign", () => {
    const item = CASES.find((candidate) => candidate.id === "data-question")!;
    const statistics = item.checks.find((check) => check.id === "statistics")!;
    const table = (minus: string) =>
      `| STN-11 | 8,637 | 8.4 °C |\n| STN-12 | 8,638 | 14.1 °C |\n| STN-13 | 8,633 | ${minus}2.7 °C |`;
    const run = (answer: string) => statistics.run({ answer, answers: [answer], reports: [] } as never);
    expect(run(table("-"))).toMatchObject({ pass: true });
    expect(run(table("\u2212"))).toMatchObject({ pass: true });
    expect(run(table(""))).toEqual({ pass: false, detail: "missing STN-13 mean" });
  });
});

describe("the generated readings of data-question", () => {
  test("are the same every time, a year of hours for three stations, and Python finds the expected answer", () => {
    const first = readingsCsv();
    expect(readingsCsv()).toEqual(first);
    const lines = first.csv.trimEnd().split("\n");
    expect(lines[0]).toBe("station,time,temperature");
    expect(lines).toHaveLength(1 + 3 * 365 * 24);
    for (const station of first.stations) {
      // Far from a rounding boundary, so any correct tool rounds the mean the same way.
      const tenths = station.mean * 10;
      expect(Math.abs(tenths - Math.floor(tenths) - 0.5)).toBeGreaterThan(0.05);
    }
    const dir = mkdtempSync(path.join(tmpdir(), "readings-"));
    try {
      writeFileSync(path.join(dir, "readings.csv"), first.csv);
      const script =
        "import csv\nrows = {}\nfor r in csv.DictReader(open('readings.csv')):\n" +
        "    t = r['temperature']\n    if t == 'NA':\n        continue\n    v = float(t)\n" +
        "    if -90 <= v <= 60:\n        rows.setdefault(r['station'], []).append(v)\n" +
        "for s in sorted(rows):\n    print(s, len(rows[s]), f'{sum(rows[s]) / len(rows[s]):.1f}')\n";
      const result = exec(["python3", "-c", script], { cwd: dir });
      expect(result.output.trim().split("\n")).toEqual(first.stations.map((station) => `${station.id} ${station.valid} ${station.mean.toFixed(1)}`));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
