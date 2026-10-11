// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

// Release a version in one step: `make release X.Y.Z` (`bun tools/release.ts X.Y.Z`).
//
//   1. Check the repository is ready: on main, nothing uncommitted, level with origin/main, the
//      version newer than VERSION, entries under [Unreleased], no tag or release of it yet.
//   2. Run the full gate (`make check`) before changing anything.
//   3. Set the version (VERSION, package.json), move [Unreleased] under it in CHANGELOG.md and
//      rebuild dist/, which embeds the version. Run the gate again; if it fails, put the files
//      back as they were.
//   4. Commit as `chore: release X.Y.Z` and push main.
//   5. Tag the release commit `X.Y.Z`, push the tag, and publish the GitHub release with the
//      CHANGELOG section as its notes.
//
// Running the same command again picks up where an earlier run stopped: after a rejected push
// (pull, then run it again: the release commit is rebuilt and checked again on top of what came
// in), or when the tag or the GitHub release is missing. `--dry-run` (`DRY_RUN=1`) shows what
// would happen and changes nothing.

import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { VERSION_FILE } from "./load.ts";
import { CHANGELOG_FILE, PACKAGE_FILE, VersionError, checkVersion, compareVersions, consistencyProblems, parseChangelog, releaseNotes, setVersion } from "./version.ts";

/** Files a release commit may change. */
export const RELEASE_PATHS = [VERSION_FILE, PACKAGE_FILE, CHANGELOG_FILE, "dist"];

export interface CommandResult {
  ok: boolean;
  out: string;
  err: string;
}

export interface ReleaseOptions {
  root: string;
  version: string;
  dryRun: boolean;
  /** Release date, YYYY-MM-DD; today in UTC by default. */
  date?: string;
  /** Run a command in the repository; output goes to the terminal when `inherit` is set. */
  run?: (argv: string[], inherit?: boolean) => CommandResult;
  /** The gate and the build; replaced in tests. */
  check?: string[];
  build?: string[];
  /** The GitHub CLI. */
  gh?: string;
  log?: (line: string) => void;
}

export class ReleaseError extends Error {}

function fail(message: string): never {
  throw new ReleaseError(message);
}

function defaultRun(root: string) {
  return (argv: string[], inherit = false): CommandResult => {
    const result = Bun.spawnSync(argv, {
      cwd: root,
      stdin: "inherit",
      stdout: inherit ? "inherit" : "pipe",
      stderr: inherit ? "inherit" : "pipe",
    });
    return { ok: result.exitCode === 0, out: result.stdout?.toString().trim() ?? "", err: result.stderr?.toString().trim() ?? "" };
  };
}

/** What already exists of a release, so a run can pick up where an earlier one stopped. */
export interface ReleaseState {
  version: string;
  current: string;
  /** VERSION says the version and CHANGELOG.md has its section. */
  prepared: boolean;
  /** The release commit, if one is reachable from HEAD. */
  commit?: string;
  /** The release commit is on origin/main. */
  pushed: boolean;
  tagLocal: boolean;
  tagRemote: boolean;
  published: boolean;
}

export function releaseSubject(version: string): string {
  return `chore: release ${version}`;
}

export function inspect(options: Required<Pick<ReleaseOptions, "root" | "version" | "run" | "gh">>): ReleaseState {
  const { root, version, run } = options;
  const git = (...args: string[]) => run(["git", ...args]);
  const current = checkVersion(readFileSync(path.join(root, VERSION_FILE), "utf8"));
  const sections = parseChangelog(readFileSync(path.join(root, CHANGELOG_FILE), "utf8")).sections;
  const prepared = current === version && sections.some((section) => section.version === version);
  let commit: string | undefined;
  for (const line of git("log", "--format=%H %s", "-n", "200", "HEAD").out.split("\n")) {
    const space = line.indexOf(" ");
    if (space > 0 && line.slice(space + 1) === releaseSubject(version)) {
      commit = line.slice(0, space);
      break;
    }
  }
  const pushed = commit !== undefined && git("merge-base", "--is-ancestor", commit, "origin/main").ok;
  const tagLocal = git("rev-parse", "-q", "--verify", `refs/tags/${version}`).ok;
  const tagRemote = git("ls-remote", "--tags", "origin", `refs/tags/${version}`).out !== "";
  const published = run([options.gh, "release", "view", version]).ok;
  return { version, current, prepared, commit, pushed, tagLocal, tagRemote, published };
}

/** Files with uncommitted changes, as paths relative to the repository root. */
function changedFiles(run: NonNullable<ReleaseOptions["run"]>): string[] {
  return run(["git", "status", "--porcelain", "--untracked-files=all"])
    .out.split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => line.slice(3).replace(/^.* -> /, ""));
}

function isReleasePath(file: string): boolean {
  return RELEASE_PATHS.some((item) => file === item || file.startsWith(`${item}/`));
}

/** Problems that stop a release from starting; empty when it may go ahead. */
export function readiness(options: Required<Pick<ReleaseOptions, "root" | "version" | "run" | "gh">>, state: ReleaseState): string[] {
  const { root, version, run } = options;
  const problems = consistencyProblems(root);
  const branch = run(["git", "rev-parse", "--abbrev-ref", "HEAD"]).out;
  if (branch !== "main") problems.push(`releases are made from main, but the current branch is ${branch}`);
  const changed = changedFiles(run);
  if (state.commit === undefined && state.prepared) {
    const other = changed.filter((file) => !isReleasePath(file));
    if (other.length > 0) problems.push(`uncommitted changes outside the release files: ${other.join(", ")}`);
  } else if (changed.length > 0) {
    problems.push(`uncommitted changes: ${changed.join(", ")}; commit or stash them first`);
  }
  const head = run(["git", "rev-parse", "HEAD"]).out;
  const remote = run(["git", "rev-parse", "origin/main"]).out;
  if (state.commit === undefined) {
    if (head !== remote) problems.push("main is not level with origin/main: pull or push first");
    if (!state.prepared) {
      // The current version itself may be released once: a new project starts with one that
      // has no CHANGELOG section yet.
      if (compareVersions(version, state.current) < 0) problems.push(`${version} is older than the current version ${state.current}`);
      try {
        const parsed = parseChangelog(readFileSync(path.join(root, CHANGELOG_FILE), "utf8"));
        const lines = parsed.lines.slice(parsed.unreleased.start + 1, parsed.unreleased.end).filter((line) => line.trim() !== "");
        if (lines.length === 0) problems.push(`nothing under [Unreleased] in ${CHANGELOG_FILE}: describe the changes of ${version} there first`);
      } catch (error) {
        problems.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (state.tagLocal || state.tagRemote) problems.push(`a tag ${version} already exists without its release commit; remove it or choose another version`);
  } else if (!state.pushed) {
    if (!run(["git", "merge-base", "--is-ancestor", "origin/main", "HEAD"]).ok) {
      problems.push("origin/main has commits that are not here: run git pull --rebase, then make release again");
    }
    if (head !== state.commit) problems.push(`the release commit is not the last commit on main; move ${short(state.commit)} to the top first`);
  }
  if (!run([options.gh, "auth", "status"]).ok) problems.push("the GitHub CLI is not logged in (gh auth login)");
  return problems;
}

function short(commit: string): string {
  return commit.slice(0, 12);
}

/** The steps still to do, in order, for the log and the dry run. */
export function plan(state: ReleaseState): string[] {
  const steps: string[] = [];
  if (state.commit === undefined) {
    if (!state.prepared) steps.push("run the gate (make check)");
    steps.push(
      state.prepared ? "rebuild dist/" : `set the version ${state.version} and move [Unreleased] under it, then rebuild dist/`,
      "run the gate again",
      `commit as "${releaseSubject(state.version)}"`,
    );
  } else if (!state.pushed) {
    steps.push("rebuild dist/ and amend the release commit if that changes it", "run the gate again");
  }
  if (!state.pushed) steps.push("push main");
  if (!state.tagLocal) steps.push(`tag the release commit ${state.version}`);
  if (!state.tagRemote) steps.push(`push the tag ${state.version}`);
  if (!state.published) steps.push(`publish the GitHub release ${state.version}`);
  return steps;
}

export function release(options: ReleaseOptions): void {
  const log = options.log ?? console.log;
  const run = options.run ?? defaultRun(options.root);
  const gh = options.gh ?? "gh";
  const check = options.check ?? ["make", "--no-print-directory", "check"];
  const build = options.build ?? [process.execPath, "tools/build.ts"];
  const version = checkVersion(options.version);
  const base = { root: options.root, version, run, gh };

  if (!run(["git", "fetch", "--quiet", "--tags", "origin"]).ok) fail("git fetch origin failed");
  let state = inspect(base);
  if (state.published && state.tagRemote) {
    log(`${version} is already released.`);
    return;
  }
  const problems = readiness(base, state);
  if (problems.length > 0) fail(`not ready to release ${version}:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`);

  const steps = plan(state);
  log(`${options.dryRun ? "Would release" : "Releasing"} ${version}:`);
  for (const [index, step] of steps.entries()) log(`  ${index + 1}. ${step}`);
  if (options.dryRun) {
    log("");
    log("Notes for the GitHub release:");
    try {
      const notes = state.prepared
        ? releaseNotes(readFileSync(path.join(options.root, CHANGELOG_FILE), "utf8"), version)
        : unreleasedNotes(options.root);
      log(notes.trimEnd());
    } catch (error) {
      log(`  (${error instanceof Error ? error.message : String(error)})`);
    }
    return;
  }

  const step = (what: string, argv: string[], inherit = false) => {
    log(`> ${what}`);
    const result = run(argv, inherit);
    if (!result.ok) fail(`${what} failed${result.err ? `: ${result.err}` : ""}`);
    return result;
  };

  if (state.commit === undefined) {
    if (!state.prepared) {
      step("make check", check, true);
      for (const change of setVersion(options.root, version, options.date ?? new Date().toISOString().slice(0, 10))) log(`  ${change}`);
    }
    try {
      step("rebuild dist/", build, true);
      step("make check", check, true);
    } catch (error) {
      run(["git", "checkout", "HEAD", "--", ...RELEASE_PATHS]);
      run(["git", "clean", "-fdq", "--", "dist"]);
      throw new ReleaseError(
        `${error instanceof Error ? error.message : String(error)}\nThe release files are back as they were. Fix the problem, commit it, then run make release ${version} again.`,
      );
    }
    step("stage the release files", ["git", "add", "-A", "--", ...RELEASE_PATHS]);
    const other = changedFiles(run).filter((file) => !isReleasePath(file));
    if (other.length > 0) fail(`the gate changed files outside the release: ${other.join(", ")}`);
    step("commit", ["git", "commit", "-q", "-m", releaseSubject(version)]);
    state = inspect(base);
  } else if (!state.pushed) {
    // The release commit was made, but not pushed; after a pull it sits on newer commits, so
    // dist/ may be out of date. Rebuild, fold any difference into the release commit, re-check.
    step("rebuild dist/", build, true);
    const changed = changedFiles(run);
    const other = changed.filter((file) => !isReleasePath(file));
    if (other.length > 0) fail(`the build changed files outside the release: ${other.join(", ")}`);
    if (changed.length > 0) {
      step("stage the rebuilt files", ["git", "add", "-A", "--", ...RELEASE_PATHS]);
      step("amend the release commit", ["git", "commit", "-q", "--amend", "--no-edit"]);
    }
    step("make check", check, true);
    state = inspect(base);
  }
  if (!state.pushed) {
    log("> push main");
    const pushed = run(["git", "push", "origin", "HEAD:main"], true);
    if (!pushed.ok) {
      fail(`the push was rejected. Someone may have pushed meanwhile: run git pull --rebase, then make release ${version} again.`);
    }
  }
  if (!state.tagLocal) step(`tag ${version}`, ["git", "tag", "-a", version, "-m", version, state.commit ?? "HEAD"]);
  if (!state.tagRemote) step(`push the tag ${version}`, ["git", "push", "origin", `refs/tags/${version}`], true);
  if (!state.published) {
    const notes = releaseNotes(readFileSync(path.join(options.root, CHANGELOG_FILE), "utf8"), version);
    const notesFile = path.join(run(["git", "rev-parse", "--absolute-git-dir"]).out, `release-notes-${version}.md`);
    writeFileSync(notesFile, notes);
    try {
      step(`publish the GitHub release ${version}`, [gh, "release", "create", version, "--title", version, "--notes-file", notesFile, "--verify-tag"], true);
    } finally {
      rmSync(notesFile, { force: true });
    }
  }
  log(`Released ${version}.`);
}

/** The [Unreleased] entries, for the dry run before the changelog is rolled. */
function unreleasedNotes(root: string): string {
  const parsed = parseChangelog(readFileSync(path.join(root, CHANGELOG_FILE), "utf8"));
  const lines = parsed.lines.slice(parsed.unreleased.start + 1, parsed.unreleased.end);
  while (lines.length > 0 && lines[0]!.trim() === "") lines.shift();
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
  if (lines.length === 0) fail(`nothing under [Unreleased] in ${CHANGELOG_FILE}`);
  return `${lines.join("\n")}\n`;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const version = args.find((arg) => !arg.startsWith("--"));
  if (version === undefined) {
    console.error("usage: make release X.Y.Z [DRY_RUN=1]");
    process.exit(2);
  }
  try {
    release({ root: path.resolve(import.meta.dir, ".."), version, dryRun });
  } catch (error) {
    if (error instanceof ReleaseError || error instanceof VersionError) {
      console.error(`error: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
}
