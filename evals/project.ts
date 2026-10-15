// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

// Sandboxes and projects for eval runs: a fresh directory per run with HOME and the XDG
// directories inside it (tools/sandbox.sh), the chosen opencode 2 binary linked in as
// `opencode`, a git project copied from the fixture with a fixed identity, and the harness
// installed with install.sh or a baseline opencode.json. Logins come from login.ts.

import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CommandResult, SetupStep, Variant } from "./types.ts";

export const REPO = path.resolve(import.meta.dir, "..");
export const SANDBOX_SCRIPT = path.join(REPO, "tools", "sandbox.sh");
export const FIXTURE = path.join(REPO, "evals", "fixtures", "stations");
export const HIDDEN = path.join(REPO, "evals", "hidden");
export const WORK_DIR = ".ecmwf-multi-agents";
export const NAME = "ecmwf-multi-agents";

/** Fixed identity for the project's git history and for commits agents make. */
export const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: "Eval User",
  GIT_AUTHOR_EMAIL: "eval.user@example.invalid",
  GIT_COMMITTER_NAME: "Eval User",
  GIT_COMMITTER_EMAIL: "eval.user@example.invalid",
  GIT_CONFIG_NOSYSTEM: "1",
};

/** Date of the first setup commit; each later setup commit is one hour on. */
const FIRST_COMMIT = Date.parse("2026-10-01T09:00:00Z");

/** Environment variables passed through to opencode and the commands it runs; nothing else is. */
const PASS_THROUGH = ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "SHELL", "USER", "LOGNAME", "TZ", "TMPDIR"];

export interface Profile {
  name: string;
  /** Per-agent model and variant, as the harness profile file lists them. */
  agents: Record<string, { model?: string; variant?: string }>;
}

export interface Box {
  dir: string;
  home: string;
  config: string;
  project: string;
  remote?: string;
  /** Folder holding the `opencode` link to the run's binary; first on the run's PATH. */
  bin?: string;
}

// ---------------------------------------------------------------------------------------------
// Profiles, plugins, versions

/** Reads a profile from the built harness; the per-agent effort key may be variant or effort. */
export function loadProfile(name: string, repo = REPO): Profile {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error(`invalid profile name: ${name}`);
  const file = path.join(repo, "dist", "opencode-v2", NAME, "profiles", `${name}.json`);
  if (!existsSync(file)) throw new Error(`unknown profile ${name}: ${path.relative(repo, file)} does not exist (run bun run build?)`);
  return parseProfile(name, JSON.parse(readFileSync(file, "utf8")));
}

export function parseProfile(name: string, data: unknown): Profile {
  const agents: Profile["agents"] = {};
  const listed = (data as { agents?: unknown } | null)?.agents;
  if (listed && typeof listed === "object") {
    for (const [agent, value] of Object.entries(listed as Record<string, unknown>)) {
      const entry = (value ?? {}) as { model?: unknown; variant?: unknown; effort?: unknown };
      const variant = typeof entry.variant === "string" ? entry.variant : typeof entry.effort === "string" ? entry.effort : undefined;
      agents[agent] = {
        ...(typeof entry.model === "string" ? { model: entry.model } : {}),
        ...(variant ? { variant } : {}),
      };
    }
  }
  return { name, agents };
}

/** Providers the profile's models come from, sorted. */
export function profileProviders(profile: Profile): string[] {
  const providers = new Set<string>();
  for (const agent of Object.values(profile.agents)) {
    const provider = agent.model?.split("/")[0];
    if (provider) providers.add(provider);
  }
  return [...providers].sort();
}

/**
 * Extra opencode 2 plugins the sandbox loads, from $ECMWF_MULTI_AGENTS_EVAL_PLUGINS (separated
 * by spaces or commas). The sandbox never loads the owner's own opencode config, so a provider
 * whose login needs a plugin (an OAuth login, for example) is listed here.
 */
export function loginPlugins(env: Record<string, string | undefined> = process.env): string[] {
  return (env.ECMWF_MULTI_AGENTS_EVAL_PLUGINS ?? "").split(/[\s,]+/).filter((item) => item !== "");
}

/** The version in `opencode --version` output, such as 2.0.28 from "opencode v2.0.28". */
export function parseVersion(output: string): string {
  return /(\d+\.\d+\.\d+\S*)/.exec(output)?.[1] ?? "";
}

/** The binary's version, asked inside a throwaway sandbox; empty when it cannot be run. */
export function opencodeVersion(bin: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ecmwf-eval-"));
  try {
    const result = Bun.spawnSync([SANDBOX_SCRIPT, dir, bin, "--version"], { cwd: dir, stdout: "pipe", stderr: "pipe", env: baseEnv(), timeout: 60_000 });
    return parseVersion(result.stdout.toString());
  } catch {
    return "";
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** An opencode binary as a path: a bare name is looked up on PATH. Undefined when not found. */
export function resolveBinary(bin: string): string | undefined {
  if (bin.includes("/")) return existsSync(bin) ? path.resolve(bin) : undefined;
  return Bun.which(bin) ?? undefined;
}

// ---------------------------------------------------------------------------------------------
// Commands

/** The environment for every command of a run: a short pass-through list, git identity, extras. */
export function baseEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of PASS_THROUGH) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return { ...env, ...GIT_IDENTITY, PYTHONDONTWRITEBYTECODE: "1", ...extra };
}

export function exec(argv: string[], options: { cwd: string; env?: Record<string, string>; timeoutMs?: number }): CommandResult {
  const result = Bun.spawnSync(argv, {
    cwd: options.cwd,
    env: baseEnv(options.env),
    stdout: "pipe",
    stderr: "pipe",
    timeout: options.timeoutMs ?? 120_000,
  });
  return { code: result.exitCode ?? -1, output: result.stdout.toString() + result.stderr.toString() };
}

function must(argv: string[], options: { cwd: string; env?: Record<string, string> }): string {
  const result = exec(argv, options);
  if (result.code !== 0) throw new Error(`${argv.join(" ")} failed (${result.code}): ${result.output.trim()}`);
  return result.output.trim();
}

// ---------------------------------------------------------------------------------------------
// Sandbox and project

/** Sandboxes not yet removed, so an interrupted runner can remove them. */
const liveBoxes = new Set<Box>();

/** Removes every sandbox still on disk; for signal handlers. */
export function removeLiveBoxes(): void {
  for (const box of [...liveBoxes]) removeBox(box);
}

/**
 * Names opencode 2 loads from the project folder and every folder above it, up to the file
 * system root (core/src/config/discovery.ts at v2.0.29).
 */
export const PROJECT_CONFIG_NAMES = [".claude", ".agents", ".opencode", "opencode.jsonc", "opencode.json"];

function present(file: string): boolean {
  try {
    lstatSync(file);
    return true;
  } catch {
    return false;
  }
}

/** Every opencode project config file or folder in `dir` and the folders above it, nearest first. */
export function projectConfigFrom(dir: string, exists: (file: string) => boolean = present): string[] {
  const found: string[] = [];
  for (let current = path.resolve(dir); ; current = path.dirname(current)) {
    for (const name of PROJECT_CONFIG_NAMES) {
      const file = path.join(current, name);
      if (exists(file)) found.push(file);
    }
    if (current === path.dirname(current)) return found;
  }
}

/**
 * Why sandboxes in `parent` are unsafe, or undefined when they are safe. The sandboxed server
 * reads the fixture's own project config, so it cannot switch that search off; opencode config
 * in a folder above the sandbox (another user's /tmp/opencode.json, say) would load into the
 * server that holds the eval login.
 */
export function sandboxParentProblem(parent: string, exists?: (file: string) => boolean): string | undefined {
  const found = projectConfigFrom(parent, exists);
  if (found.length === 0) return undefined;
  return `opencode would load ${found.join(", ")} into every eval sandbox under ${parent}, because it reads project config from every folder above the project; remove it, or set TMPDIR to a folder where neither it nor any folder above it holds ${PROJECT_CONFIG_NAMES.join(", ")} (a new folder under /var/tmp, say)`;
}

/** A fresh sandbox under the system temporary directory, with the fixture as a git project. */
export function createBox(fixture = FIXTURE): Box {
  // opencode reports canonical paths, so resolve symbolic links in the temporary directory.
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "ecmwf-eval-")));
  const home = path.join(dir, "home");
  for (const sub of [".config/opencode", ".local/share/opencode", ".local/state", ".cache"]) mkdirSync(path.join(home, sub), { recursive: true });
  const project = path.join(dir, "project");
  cpSync(fixture, project, { recursive: true, filter: (source) => !/(^|\/)(__pycache__|\.pytest_cache)(\/|$)|\.pyc$/.test(source) });
  const box: Box = { dir, home, config: path.join(home, ".config", "opencode"), project };
  liveBoxes.add(box);
  must(["git", "init", "-q", "-b", "main"], { cwd: project });
  return box;
}

export function removeBox(box: Box): void {
  // chmod -R skips symbolic links it meets, and rmSync removes the opencode link itself, never
  // the binary it points to.
  Bun.spawnSync(["chmod", "-R", "u+w", box.dir]);
  rmSync(box.dir, { recursive: true, force: true });
  liveBoxes.delete(box);
}

function commitEnv(index: number): Record<string, string> {
  const date = new Date(FIRST_COMMIT + index * 3_600_000).toISOString().replace(".000Z", "Z");
  return { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
}

function inside(project: string, rel: string): string {
  const target = path.resolve(project, rel);
  if (target !== project && !target.startsWith(`${project}${path.sep}`)) throw new Error(`setup path outside the project: ${rel}`);
  return target;
}

/** The initial commit of the fixture, then the case's steps. Returns HEAD afterwards. */
export function applySetup(box: Box, steps: SetupStep[]): string {
  let commits = 0;
  const project = box.project;
  must(["git", "add", "-A"], { cwd: project });
  must(["git", "commit", "-q", "-m", "Initial version of the stations package"], { cwd: project, env: commitEnv(commits++) });
  for (const step of steps) {
    switch (step.kind) {
      case "write": {
        const target = inside(project, step.path);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, step.content);
        if (step.mtime) {
          const time = new Date(step.mtime);
          utimesSync(target, time, time);
        }
        break;
      }
      case "replace": {
        const target = inside(project, step.path);
        const text = readFileSync(target, "utf8");
        const count = text.split(step.find).length - 1;
        if (count !== 1) throw new Error(`setup: expected the text once in ${step.path}, found it ${count} times: ${JSON.stringify(step.find)}`);
        writeFileSync(target, text.replace(step.find, () => step.replace));
        break;
      }
      case "remove":
        rmSync(inside(project, step.path), { recursive: true, force: true });
        break;
      case "commit":
        must(["git", "add", "-A"], { cwd: project });
        must(["git", "commit", "-q", "-m", step.message], { cwd: project, env: commitEnv(commits++) });
        break;
      case "remote": {
        const remote = path.join(box.dir, "remote.git");
        must(["git", "init", "-q", "--bare", "-b", "main", remote], { cwd: box.dir });
        must(["git", "remote", "add", "origin", remote], { cwd: project });
        must(["git", "push", "-q", "-u", "origin", "main"], { cwd: project });
        box.remote = remote;
        break;
      }
      case "exclude-workdir": {
        const exclude = path.join(project, must(["git", "rev-parse", "--git-path", "info/exclude"], { cwd: project }));
        mkdirSync(path.dirname(exclude), { recursive: true });
        const current = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
        writeFileSync(exclude, `${current}${current === "" || current.endsWith("\n") ? "" : "\n"}${WORK_DIR}/\n`);
        break;
      }
    }
  }
  return must(["git", "rev-parse", "HEAD"], { cwd: project });
}

/**
 * Links the run's opencode binary into the sandbox as `opencode` and returns the link. With its
 * folder first on PATH, install.sh finds this binary, whatever else is installed.
 */
export function linkOpencode(box: Box, bin: string): string {
  const dir = path.join(box.dir, "bin");
  mkdirSync(dir, { recursive: true });
  const link = path.join(dir, "opencode");
  symlinkSync(bin, link);
  box.bin = dir;
  return link;
}

/** The run's PATH: the sandbox's opencode first, then the runner's own PATH. */
export function sandboxPath(box: Box): string {
  return [box.bin, process.env.PATH].filter((item) => item !== undefined && item !== "").join(":");
}

/** Runs a command inside the sandbox (tools/sandbox.sh), with the run's environment. */
export function inSandbox(box: Box, argv: string[], options: { cwd: string; env?: Record<string, string>; timeoutMs?: number }): CommandResult {
  return exec([SANDBOX_SCRIPT, box.dir, ...argv], options);
}

/** Installs the harness from this checkout into the sandbox: global and linked, for the run's opencode. */
export function installHarness(box: Box, profile: string, review: string, repo = REPO): void {
  const result = inSandbox(box, ["sh", path.join(repo, "install.sh"), "--link", "--profile", profile, "--review", review], { cwd: repo, env: { PATH: sandboxPath(box) } });
  if (result.code !== 0) throw new Error(`install.sh failed (${result.code}):\n${result.output.trim()}`);
}

/**
 * The sandbox opencode.json, in opencode 2 keys. Both variants: only the profile's providers,
 * lead's model as the session model, sharing and updates off, and the extra plugins. Baseline:
 * the built-in build agent on lead's model and effort (provider/model#variant).
 */
export function opencodeConfig(variant: Variant, profile: Profile, extra: Record<string, unknown> = {}, plugins: string[] = []): Record<string, unknown> {
  const lead = profile.agents.lead ?? {};
  const providers = profileProviders(profile);
  const config: Record<string, unknown> = { share: "disabled", update: "disable" };
  if (plugins.length > 0) config.plugins = plugins;
  if (providers.length > 0) {
    config.policies = [
      { action: "provider.use", resource: "*", effect: "deny" },
      ...providers.map((provider) => ({ action: "provider.use", resource: provider, effect: "allow" })),
    ];
  }
  if (lead.model) config.model = lead.model;
  if (variant === "baseline") config.agents = { build: lead.model ? { model: lead.variant ? `${lead.model}#${lead.variant}` : lead.model } : {} };
  return { ...config, ...extra };
}

export function writeConfig(box: Box, config: Record<string, unknown>): void {
  writeFileSync(path.join(box.config, "opencode.json"), `${JSON.stringify(config, null, 2)}\n`);
}

// ---------------------------------------------------------------------------------------------
// Changes

const IGNORED = /(^|\/)(\.git|__pycache__|\.pytest_cache)(\/|$)|\.pyc$/;

/** Content hash of every file in the project, outside .git and Python caches. */
export function snapshot(project: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(project, full);
      if (IGNORED.test(rel)) continue;
      if (entry.isDirectory()) walk(full);
      else if (entry.isSymbolicLink()) files.set(rel, `link:${lstatSync(full).size}`);
      else if (entry.isFile()) files.set(rel, createHash("sha256").update(readFileSync(full)).digest("hex"));
    }
  };
  walk(project);
  return files;
}

/** Paths added, changed or removed between two snapshots, sorted. */
export function changedBetween(before: Map<string, string>, after: Map<string, string>): string[] {
  const changed = new Set<string>();
  for (const [file, hash] of after) if (before.get(file) !== hash) changed.add(file);
  for (const file of before.keys()) if (!after.has(file)) changed.add(file);
  return [...changed].sort();
}

/** Reads a project file, or undefined when it does not exist or is outside the project. */
export function readProjectFile(project: string, rel: string): string | undefined {
  try {
    return readFileSync(inside(project, rel), "utf8");
  } catch {
    return undefined;
  }
}

/** Files under a project folder, recursively, as paths relative to the project. */
export function listProjectFiles(project: string, relDir: string): string[] {
  const out: string[] = [];
  let base: string;
  try {
    base = inside(project, relDir);
  } catch {
    return out;
  }
  const walk = (dir: string) => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(path.relative(project, full));
    }
  };
  walk(base);
  return out.sort();
}

/** The project's diff against the setup commit, untracked files included, shortened. */
export function projectDiff(project: string, head: string, limit = 60_000): string {
  exec(["git", "add", "-A", "-N", "."], { cwd: project });
  const diff = exec(["git", "-c", "core.quotepath=off", "diff", head, "--stat", "--patch"], { cwd: project }).output;
  exec(["git", "reset", "-q"], { cwd: project });
  return diff.length <= limit ? diff : `${diff.slice(0, limit)}\n[... ${diff.length - limit} more characters]`;
}
