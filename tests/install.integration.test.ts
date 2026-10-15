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
    expect(doctor.out).toContain("OK    lead is the default agent");
    expect(install(box, ["uninstall"]).code).toBe(0);
    expect(ourFiles(box.config)).toEqual([]);
    expect(existsSync(path.join(REPO, "dist", "opencode-v2", "plugins", NAME, "index.js"))).toBe(true);
  }, TIMEOUT);

  (V2_BIN ? test : test.skip)("doctor --project for a project whose plugins line names this checkout", () => {
    const box = sandbox(V2_BIN!);
    writeFileSync(path.join(box.project, "opencode.json"), `${JSON.stringify({ plugins: [REPO] })}\n`);
    const doctor = install(box, ["doctor", "--project", box.project], box.project);
    expect(doctor.out).toContain(`OK    switched on by the plugins line in ${path.join(box.project, "opencode.json")}: ${REPO}`);
    expect(doctor.out).toContain(`OK    the checkout ${REPO} has the plugin folder`);
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
});
