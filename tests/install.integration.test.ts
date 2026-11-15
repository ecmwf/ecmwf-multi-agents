// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

// Installs the real dist/ with install.sh into sandboxes and checks the result with real
// opencode. Opt-in: set ECMWF_MULTI_AGENTS_INTEGRATION=1. Binary: OPENCODE_V2_BIN, the tested
// opencode 2 version (default: "opencode2" on PATH; skipped if missing).

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const REPO = path.resolve(import.meta.dir, "..");
const SANDBOX = path.join(REPO, "tools", "sandbox.sh");
const INSTALL = path.join(REPO, "install.sh");
const NAME = "ecmwf-multi-agents";
const ENABLED = process.env.ECMWF_MULTI_AGENTS_INTEGRATION === "1";
const HAVE_DIST = existsSync(path.join(REPO, "dist", "opencode-v2", NAME, "files.txt"));
const TIMEOUT = 300_000;

function resolveBin(name: string): string | undefined {
  if (name.includes("/")) return existsSync(name) ? name : undefined;
  return Bun.which(name) ?? undefined;
}

const V2_BIN = resolveBin(process.env.OPENCODE_V2_BIN ?? "opencode2");

if (ENABLED && !HAVE_DIST) console.warn("dist/ is missing: run bun run build first; skipping the install integration tests");
const run_ = ENABLED && HAVE_DIST ? describe : describe.skip;

const sandboxes: string[] = [];
afterAll(() => {
  for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
});

interface Sandbox {
  dir: string;
  config: string;
  project: string;
  env: Record<string, string>;
}

/** A sandbox whose PATH offers the binary under test as opencode and opencode2. */
function sandbox(bin: string): Sandbox {
  const dir = mkdtempSync(path.join(tmpdir(), "install-it-"));
  sandboxes.push(dir);
  const binDir = path.join(dir, "bin");
  mkdirSync(binDir);
  symlinkSync(bin, path.join(binDir, "opencode"));
  symlinkSync(bin, path.join(binDir, "opencode2"));
  const project = path.join(dir, "project");
  mkdirSync(project);
  Bun.spawnSync(["git", "init", "-q"], { cwd: project });
  return {
    dir,
    config: path.join(dir, "home", ".config", "opencode"),
    project,
    env: { PATH: `${binDir}:/usr/local/bin:/usr/bin:/bin`, LC_ALL: "C" },
  };
}

function inSandbox(box: Sandbox, argv: string[], cwd = box.project): { code: number; out: string; err: string } {
  const result = Bun.spawnSync([SANDBOX, box.dir, ...argv], { cwd, env: box.env, stdout: "pipe", stderr: "pipe" });
  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
}

function install(box: Sandbox, args: string[] = [], cwd = REPO): { code: number; out: string } {
  const result = inSandbox(box, ["sh", INSTALL, ...args], cwd);
  return { code: result.code, out: result.out + result.err };
}

/** Every file under a folder that is ours: a link into a dist folder, or a file with the marker. */
function ourFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) {
        if (readlinkSync(full).includes("/dist/opencode-v")) found.push(full);
      } else if (stat.isDirectory()) {
        if (entry !== "node_modules") walk(full);
      } else if (readFileSync(full, "utf8").slice(0, 200).includes(`managed by ${NAME}`)) found.push(full);
    }
  };
  walk(root);
  return found;
}

run_("install.sh with real opencode", () => {
  (V2_BIN ? test : test.skip)("install, doctor, uninstall", () => {
    const box = sandbox(V2_BIN!);
    const installed = install(box);
    expect(installed.code).toBe(0);
    const lead = readFileSync(path.join(box.config, "agents", "lead.md"), "utf8");
    expect(lead).toContain("permissions:");
    expect(lead).toContain('model: "anthropic/claude-opus-5-5#xhigh"');
    expect(readlinkSync(path.join(box.config, "plugins", NAME))).toBe(path.join(REPO, "dist", "opencode-v2", "plugins", NAME));
    const doctor = install(box, ["doctor"], box.project);
    expect(doctor.code).toBe(0);
    expect(doctor.out).toContain("OK    lead is the harness's, with the plugin");
    expect(doctor.out).toContain("OK    lead's Review policy: auto");
    expect(doctor.out).toContain("OK    max_helper_slots 4; lead's instruction: Run at most 4 helpers at once.");
    expect(doctor.out).toContain("OK    helpers on: scout, builder, reviewer; off: researcher, tester, designer, data-scientist");
    expect(doctor.out).toContain("OK    lead is the default agent");
    // The optional helpers have no file: an install brings only lead and the default helpers.
    expect(readdirSync(path.join(box.config, "agents")).sort()).toEqual(["builder.md", "lead.md", "reviewer.md", "scout.md"]);
    // A project that switches a helper on and builder off: the plugin brings one and removes the other.
    mkdirSync(path.join(box.project, ".opencode"));
    writeFileSync(path.join(box.project, ".opencode", `${NAME}.jsonc`), '{ "agents": { "data-scientist": { "enabled": true }, "builder": { "enabled": false } } }\n');
    const switched = install(box, ["doctor"], box.project);
    expect(switched.code).toBe(0);
    expect(switched.out).toContain("OK    helpers on: scout, reviewer, data-scientist; off: builder, researcher, tester, designer");
    expect(switched.out).toContain(`OK    switched in the settings: builder off in ${path.join(box.project, ".opencode", `${NAME}.jsonc`)}, data-scientist on in ${path.join(box.project, ".opencode", `${NAME}.jsonc`)}`);
    expect(switched.out).not.toContain("but opencode");
    expect(switched.out).toContain("OK    lead is the harness's, with the plugin");
    rmSync(path.join(box.project, ".opencode"), { recursive: true });
    expect(install(box, ["uninstall"]).code).toBe(0);
    expect(ourFiles(box.config)).toEqual([]);
    expect(existsSync(path.join(REPO, "dist", "opencode-v2", "plugins", NAME, "index.js"))).toBe(true);
  }, TIMEOUT);

  (V2_BIN ? test : test.skip)("doctor --project for a project whose plugins line names this checkout", () => {
    const box = sandbox(V2_BIN!);
    writeFileSync(path.join(box.project, "opencode.json"), `${JSON.stringify({ plugins: [REPO] })}\n`);
    mkdirSync(path.join(box.project, ".opencode"));
    writeFileSync(path.join(box.project, ".opencode", `${NAME}.jsonc`), '{ "max_helper_slots": 6 }\n');
    const doctor = install(box, ["doctor", "--project", box.project], box.project);
    expect(doctor.out).toContain(`OK    switched on by the plugins line in ${path.join(box.project, "opencode.json")}: ${REPO}`);
    expect(doctor.out).toContain(`OK    the checkout ${REPO} has the plugin folder`);
    expect(doctor.out).toContain("OK    max_helper_slots 6; lead's instruction: Run at most 6 helpers at once.");
    expect(doctor.out).toContain("OK    lead is the harness's, with the plugin");
    expect(doctor.out).toContain("OK    lead is the default agent");
    expect(doctor.code).toBe(0);
    // A project without the line: the plugin is not active there.
    rmSync(path.join(box.project, "opencode.json"));
    const off = install(box, ["doctor", "--project", box.project], box.project);
    expect(off.code).toBe(1);
    expect(off.out).toContain("is not switched on here");
    const global = install(box, ["doctor"], box.project);
    expect(global.out).toContain("is not installed here");
  }, TIMEOUT);

  (V2_BIN && NPM_AVAILABLE ? test : test.skip)("opencode plugin add switches the harness on for every project; installed files then win", () => {
    const box = sandbox(V2_BIN!);
    const pkg = packedRepository(box);
    // opencode plugin add takes only registry and Git specs (Npm.isInstallablePackage), not file: ones.
    const spec = `${NPM}@git+file://${pkg.dir}`;
    const added = inSandbox(box, ["opencode", "plugin", "add", spec]);
    const config = path.join(box.config, "opencode.json");
    expect(added.out + added.err).toContain(`added to ${config}`);
    expect(added.code).toBe(0);
    const forProject = install(box, ["doctor", "--project", box.project], box.project);
    expect(forProject.out).toContain(`OK    switched on by the plugins line in ${config}: ${spec}\n`);
    expect(forProject.out).toContain(`OK    lead is the harness's, with the plugin ${pkg.version} active`);
    expect(forProject.code).toBe(0);
    const global = install(box, ["doctor"], box.project);
    expect(global.out).toContain(`OK    switched on for every project by the plugins line in ${config}: ${spec}\n`);
    expect(global.code).toBe(0);
    // Installed files as well: opencode keeps them and drops the line's copy.
    expect(install(box).code).toBe(0);
    const both = install(box, ["doctor", "--project", box.project], box.project);
    expect(both.out).toContain(`WARN  the files installed in ${box.config} and the plugins line in ${config} (${spec}) both bring the harness; opencode keeps the installed files`);
    expect(both.out).toContain(`OK    lead is the harness's, with the plugin ${pkg.repoVersion} active`);
    expect(both.out).not.toContain(pkg.version);
    expect(install(box, ["uninstall"]).code).toBe(0);
    expect(inSandbox(box, ["opencode", "plugin", "remove", spec]).code).toBe(0);
    expect(readFileSync(config, "utf8")).not.toContain(NPM);
    const off = install(box, ["doctor", "--project", box.project], box.project);
    expect(off.out).toContain("is not switched on here");
    expect(off.code).toBe(1);
  }, TIMEOUT);
});

const NPM = "@ecmwf.int/multi-agents";
const NPM_AVAILABLE = Bun.which("npm") !== null && Bun.which("git") !== null;
if (ENABLED && V2_BIN && !NPM_AVAILABLE) console.warn("skipping the opencode plugin add test: it needs npm and git");

/**
 * This repository packed as `npm pack` would publish it, in a Git repository that a
 * `git+file:` spec can name. Two changes tell it apart and let it install: its plugin reports
 * the version "<version>-line", so a check can see which copy opencode keeps, and it has no
 * scripts, because npm runs `npm install` and the build of a Git dependency with a build
 * script, which the packed files cannot do.
 */
function packedRepository(box: Sandbox): { dir: string; version: string; repoVersion: string } {
  const repoVersion = readFileSync(path.join(REPO, "VERSION"), "utf8").trim();
  const version = `${repoVersion}-line`;
  const pack = path.join(box.dir, "pack");
  mkdirSync(pack);
  const packed = Bun.spawnSync(["npm", "pack", "--json", "--ignore-scripts", "--pack-destination", pack], { cwd: REPO, stdout: "pipe", stderr: "pipe" });
  if (packed.exitCode !== 0) throw new Error(`npm pack failed: ${packed.stderr.toString().trim()}`);
  const filename = (JSON.parse(packed.stdout.toString()) as Array<{ filename: string }>)[0]!.filename;
  const dir = path.join(box.dir, "package");
  mkdirSync(dir);
  const untar = Bun.spawnSync(["tar", "-xzf", path.join(pack, filename), "-C", dir, "--strip-components=1"]);
  if (untar.exitCode !== 0) throw new Error(`tar failed: ${untar.stderr.toString().trim()}`);
  const manifestFile = path.join(dir, "package.json");
  const { scripts: _, ...manifest } = JSON.parse(readFileSync(manifestFile, "utf8")) as Record<string, unknown>;
  writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  const entry = path.join(dir, "dist", "opencode-v2", "plugins", NAME, "index.js");
  const named = `name: "${NAME}", version: "${repoVersion}"`;
  const source = readFileSync(entry, "utf8");
  if (!source.includes(named)) throw new Error(`the plugin does not name its version as expected: ${named}`);
  writeFileSync(entry, source.replace(named, `name: "${NAME}", version: "${version}"`));
  const git = (args: string[]) => {
    const result = Bun.spawnSync(["git", "-c", "user.name=test", "-c", "user.email=test@example.invalid", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.toString().trim()}`);
  };
  git(["init", "-q"]);
  git(["add", "-A"]);
  git(["commit", "-qm", "packed"]);
  return { dir, version, repoVersion };
}
