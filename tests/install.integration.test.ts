// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

// Installs the real dist/ with install.sh into sandboxes and checks the result with real
// opencode binaries. Opt-in: set ECMWF_MULTI_AGENTS_INTEGRATION=1. Binaries:
//   OPENCODE_V1_BINS  space-separated opencode 1.x binaries (default: "opencode" on PATH)
//   OPENCODE_V2_BIN   the opencode 2 binary, the tested version (default: "opencode2" on PATH; skipped if missing)
// The first opencode 1.x start with a plugin installs a package into the config folder over
// the network, so timeouts are generous.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const REPO = path.resolve(import.meta.dir, "..");
const SANDBOX = path.join(REPO, "tools", "sandbox.sh");
const INSTALL = path.join(REPO, "install.sh");
const NAME = "ecmwf-multi-agents";
const ENABLED = process.env.ECMWF_MULTI_AGENTS_INTEGRATION === "1";
const HAVE_DIST = existsSync(path.join(REPO, "dist", "opencode-v1", NAME, "files.txt"));
const TIMEOUT = 300_000;

function resolveBin(name: string): string | undefined {
  if (name.includes("/")) return existsSync(name) ? name : undefined;
  return Bun.which(name) ?? undefined;
}

const V1_BINS = (process.env.OPENCODE_V1_BINS ?? "opencode").split(/\s+/).filter(Boolean).map(resolveBin).filter((bin): bin is string => bin !== undefined);
const V2_BIN = resolveBin(process.env.OPENCODE_V2_BIN ?? "opencode2");

if (ENABLED && !HAVE_DIST) console.warn("dist/ is missing: run bun run build first; skipping the install integration tests");
const run_ = ENABLED && HAVE_DIST ? describe : describe.skip;

const sandboxes: string[] = [];
afterAll(() => {
  for (const dir of sandboxes) {
    Bun.spawnSync(["chmod", "-R", "u+w", dir]);
    rmSync(dir, { recursive: true, force: true });
  }
});

interface Sandbox {
  dir: string;
  config: string;
  project: string;
  env: Record<string, string>;
}

/** A sandbox whose PATH offers only the binary under test, as opencode (and opencode2 for v2). */
function sandbox(bin: string, v2 = false): Sandbox {
  const dir = mkdtempSync(path.join(tmpdir(), "install-it-"));
  sandboxes.push(dir);
  const binDir = path.join(dir, "bin");
  mkdirSync(binDir);
  symlinkSync(bin, path.join(binDir, "opencode"));
  if (v2) symlinkSync(bin, path.join(binDir, "opencode2"));
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

function install(box: Sandbox, args: string[] = []): { code: number; out: string } {
  const result = inSandbox(box, ["sh", INSTALL, ...args], REPO);
  return { code: result.code, out: result.out + result.err };
}

function debugJson(box: Sandbox, args: string[], extraEnv: string[] = []): Record<string, unknown> {
  const result = inSandbox(box, ["env", ...extraEnv, "opencode", "debug", ...args]);
  expect(result.code).toBe(0);
  return JSON.parse(result.out) as Record<string, unknown>;
}

function modelOf(agent: Record<string, unknown>): string {
  const model = agent.model as { providerID: string; modelID: string } | null;
  return model ? `${model.providerID}/${model.modelID}` : "";
}

function reviewLine(agent: Record<string, unknown>): string | undefined {
  return String(agent.prompt).split("\n").find((line) => line.startsWith("Review policy:"));
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
  for (const bin of V1_BINS) {
    const version = Bun.spawnSync([bin, "--version"]).stdout.toString().trim();

    test(`opencode ${version}: install, settings through the plugin, doctor, uninstall`, () => {
      const box = sandbox(bin);
      const installed = install(box);
      expect(installed.code).toBe(0);

      const lead = debugJson(box, ["agent", "lead"]);
      expect(modelOf(lead)).toBe("anthropic/claude-opus-5-5");
      expect(reviewLine(lead)).toBe("Review policy: auto");
      expect(debugJson(box, ["config"]).default_agent).toBe("lead");

      const settings = path.join(box.config, `${NAME}.jsonc`);
      writeFileSync(settings, readFileSync(settings, "utf8").replace('"review": "auto"', '"review": "always"').replace('"profile": "default"', '"profile": "anthropic"'));
      expect(modelOf(debugJson(box, ["agent", "reviewer"]))).toBe("anthropic/claude-opus-5-5");
      expect(reviewLine(debugJson(box, ["agent", "lead"]))).toBe("Review policy: always");

      const doctor = install(box, ["doctor"]);
      expect(doctor.out).not.toContain("FAIL");
      expect(doctor.code).toBe(0);
      expect(doctor.out).toContain("OK    opencode loads the lead agent");

      expect(install(box, ["uninstall"]).code).toBe(0);
      expect(ourFiles(box.config)).toEqual([]);
    }, TIMEOUT);

    test(`opencode ${version}: a read-only central install still applies its site settings`, () => {
      const box = sandbox(bin);
      const central = path.join(box.dir, "central");
      expect(install(box, ["--central", central, "--review", "always"]).code).toBe(0);
      Bun.spawnSync(["chmod", "-R", "a-w", central]);
      const before = readdirSync(central).sort();
      const env = [`OPENCODE_CONFIG_DIR=${central}`];
      const lead = debugJson(box, ["agent", "lead"], env);
      expect(reviewLine(lead)).toBe("Review policy: always");
      expect(debugJson(box, ["config"], env).default_agent).toBe("lead");
      expect(readdirSync(central).sort()).toEqual(before);
    }, TIMEOUT);
  }

  (V2_BIN ? test : test.skip)("opencode 2: install picks the v2 files; doctor passes", () => {
    const box = sandbox(V2_BIN!, true);
    const installed = install(box);
    expect(installed.code).toBe(0);
    const lead = readFileSync(path.join(box.config, "agents", "lead.md"), "utf8");
    expect(lead).toContain("permissions:");
    expect(lead).toContain('model: "anthropic/claude-opus-5-5#xhigh"');
    const doctor = install(box, ["doctor"]);
    expect(doctor.code).toBe(0);
    expect(doctor.out).toContain("agents cannot be checked from the shell");
    expect(install(box, ["uninstall"]).code).toBe(0);
    expect(ourFiles(box.config)).toEqual([]);
  }, TIMEOUT);
});
