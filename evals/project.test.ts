// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

// Profiles, configuration, credentials handling, sandboxes and every case's setup on the
// fixture. Uses git and python3; no network and no opencode.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CASES } from "./cases.ts";
import {
  applySetup,
  authTarget,
  changedBetween,
  createBox,
  exec,
  HIDDEN,
  linkAuth,
  listProjectFiles,
  loginPlugins,
  opencodeConfig,
  parseProfile,
  profileProviders,
  projectDiff,
  readProjectFile,
  removeBox,
  snapshot,
} from "./project.ts";
import type { Box } from "./project.ts";

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

  test("harness config: providers, lead's model as session model, sharing off", () => {
    expect(opencodeConfig("harness", profile)).toEqual({
      $schema: "https://opencode.ai/config.json",
      share: "disabled",
      autoupdate: false,
      enabled_providers: ["anthropic", "github-copilot"],
      model: "anthropic/claude-opus-5-5",
    });
  });

  test("login plugins from the environment go into the plugin list", () => {
    expect(loginPlugins({ ECMWF_MULTI_AGENTS_EVAL_PLUGINS: " one@1.0, two  three " })).toEqual(["one@1.0", "two", "three"]);
    expect(loginPlugins({})).toEqual([]);
    expect(opencodeConfig("harness", profile, {}, ["one@1.0"]).plugin).toEqual(["one@1.0"]);
    expect(opencodeConfig("harness", profile).plugin).toBeUndefined();
  });

  test("baseline config: the build agent on lead's model and effort", () => {
    expect(opencodeConfig("baseline", profile)).toMatchObject({
      enabled_providers: ["anthropic", "github-copilot"],
      model: "anthropic/claude-opus-5-5",
      agent: { build: { model: "anthropic/claude-opus-5-5", variant: "xhigh" } },
    });
    expect(opencodeConfig("baseline", parseProfile("inherit", {}), { model: "mock/m1" })).toMatchObject({ model: "mock/m1", agent: { build: {} } });
  });
});

describe("credentials", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "eval-auth-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("the variable wins; a missing file gives a message without the path", () => {
    const file = path.join(dir, "auth.json");
    writeFileSync(file, "{}");
    expect(authTarget({ ECMWF_MULTI_AGENTS_EVAL_AUTH: file }, "/nonexistent-home")).toEqual({ ok: true, path: file });
    const missing = authTarget({ ECMWF_MULTI_AGENTS_EVAL_AUTH: path.join(dir, "nope.json") }, "/nonexistent-home");
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.message).not.toContain(dir);
  });

  test("the default is the opencode login file in the given home", () => {
    const home = path.join(dir, "home");
    const result = authTarget({}, home);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("<your home>/.local/share/opencode/auth.json");
  });

  test("the sandbox gets a symbolic link, and removing the sandbox keeps the target", () => {
    const target = path.join(dir, "real-auth.json");
    writeFileSync(target, "{}");
    const made = box();
    linkAuth(made, target);
    const link = path.join(made.home, ".local", "share", "opencode", "auth.json");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(target);
    removeBox(made);
    expect(existsSync(made.dir)).toBe(false);
    expect(existsSync(target)).toBe(true);
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
      // The units bug of the review-reject and review-warm cases breaks the existing tests on
      // purpose: the reviewer can find it.
      expect(tests.code).toBe(item.setup === CASES.find((other) => other.id === "review-reject")?.setup ? 1 : 0);
      const hiddenCheck = item.checks.find((check) => check.id === "hidden-tests");
      if (hiddenCheck) {
        expect(existsSync(path.join(HIDDEN, item.id))).toBe(true);
        expect(hidden(made.project, item.id).code).not.toBe(0);
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
