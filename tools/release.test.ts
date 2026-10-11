// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

// Tests for tools/release.ts against a real git repository with a local bare remote. The GitHub
// CLI is a fake script that records its calls; the gate and the build are small commands.

import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type CommandResult, ReleaseError, release } from "./release.ts";

const CHANGELOG = `# Changelog

## [Unreleased]

### Fixed

- A fix.

## [0.1.0] - 2026-10-11

- The first release.

[Unreleased]: https://github.com/ecmwf/ecmwf-multi-agents/compare/0.1.0...HEAD
[0.1.0]: https://github.com/ecmwf/ecmwf-multi-agents/releases/tag/0.1.0
`;

interface Box {
  dir: string;
  repo: string;
  remote: string;
  bin: string;
  ghLog: string;
  env: Record<string, string>;
  logs: string[];
  run: (argv: string[], inherit?: boolean) => CommandResult;
  git: (...args: string[]) => string;
}

const boxes: string[] = [];
afterEach(() => {
  for (const dir of boxes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeBox(version = "0.1.0", changelog = CHANGELOG): Box {
  const dir = mkdtempSync(path.join(tmpdir(), "release-test-"));
  boxes.push(dir);
  const repo = path.join(dir, "repo");
  const remote = path.join(dir, "remote.git");
  const bin = path.join(dir, "bin");
  const ghLog = path.join(dir, "gh.log");
  mkdirSync(repo);
  mkdirSync(bin);
  // A fake GitHub CLI: logged in unless GH_LOGGED_OUT is set; a release exists once created.
  writeFileSync(
    path.join(bin, "gh"),
    `#!/bin/sh
echo "$*" >> "${ghLog}"
case "$1 $2" in
  "auth status") [ -z "$GH_LOGGED_OUT" ] ;;
  "release view") [ -f "${dir}/released-$3" ] ;;
  "release create")
    version=$3
    touch "${dir}/released-$version"
    while [ $# -gt 0 ]; do
      if [ "$1" = "--notes-file" ]; then cp "$2" "${dir}/notes-$version"; fi
      shift
    done ;;
esac
`,
  );
  chmodSync(path.join(bin, "gh"), 0o755);
  const env: Record<string, string> = {
    PATH: `${bin}:/usr/local/bin:/usr/bin:/bin`,
    HOME: dir,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.invalid",
  };
  const logs: string[] = [];
  const run = (argv: string[]): CommandResult => {
    const result = Bun.spawnSync(argv, { cwd: repo, env, stdout: "pipe", stderr: "pipe" });
    return { ok: result.exitCode === 0, out: result.stdout.toString().trim(), err: result.stderr.toString().trim() };
  };
  const git = (...args: string[]) => {
    const result = run(["git", ...args]);
    if (!result.ok) throw new Error(`git ${args.join(" ")}: ${result.err}`);
    return result.out;
  };
  Bun.spawnSync(["git", "init", "-q", "--bare", "-b", "main", remote], { env });
  git("init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "VERSION"), `${version}\n`);
  writeFileSync(path.join(repo, "package.json"), `{\n  "name": "x",\n  "version": "${version}"\n}\n`);
  writeFileSync(path.join(repo, "CHANGELOG.md"), changelog);
  mkdirSync(path.join(repo, "dist"));
  writeFileSync(path.join(repo, "dist", "version.txt"), `${version}\n`);
  git("add", "-A");
  git("commit", "-q", "-m", "initial");
  git("remote", "add", "origin", remote);
  git("push", "-q", "-u", "origin", "main");
  return { dir, repo, remote, bin, ghLog, env, logs, run, git };
}

// The build embeds the version, as the real one does in the plugin.
const BUILD = ["sh", "-c", "cp VERSION dist/version.txt"];

function doRelease(box: Box, version: string, options: { dryRun?: boolean; check?: string[]; build?: string[] } = {}): void {
  release({
    root: box.repo,
    version,
    dryRun: options.dryRun ?? false,
    date: "2026-11-01",
    run: box.run,
    check: options.check ?? ["true"],
    build: options.build ?? BUILD,
    gh: path.join(box.bin, "gh"),
    log: (line) => box.logs.push(line),
  });
}

const read = (box: Box, file: string) => readFileSync(path.join(box.repo, file), "utf8");
const remoteRef = (box: Box, ref: string) => box.run(["git", "--git-dir", box.remote, "rev-parse", "-q", "--verify", ref]).out;
const ghCalls = (box: Box) => (existsSync(box.ghLog) ? readFileSync(box.ghLog, "utf8").trim().split("\n") : []);

describe("release", () => {
  test("a fresh release sets the version, commits, pushes, tags and publishes", () => {
    const box = makeBox();
    doRelease(box, "0.2.0");
    expect(read(box, "VERSION")).toBe("0.2.0\n");
    expect(read(box, "package.json")).toContain('"version": "0.2.0"');
    expect(read(box, "dist/version.txt")).toBe("0.2.0\n");
    expect(read(box, "CHANGELOG.md")).toContain("## [0.2.0] - 2026-11-01\n\n### Fixed\n\n- A fix.");
    expect(box.git("log", "-1", "--format=%s")).toBe("chore: release 0.2.0");
    expect(box.git("status", "--porcelain")).toBe("");
    const head = box.git("rev-parse", "HEAD");
    expect(remoteRef(box, "refs/heads/main")).toBe(head);
    expect(remoteRef(box, "refs/tags/0.2.0^{commit}")).toBe(head);
    expect(box.git("cat-file", "-t", "0.2.0")).toBe("tag");
    expect(ghCalls(box).some((call) => call.startsWith("release create 0.2.0 --title 0.2.0"))).toBe(true);
    expect(readFileSync(path.join(box.dir, "notes-0.2.0"), "utf8")).toBe("### Fixed\n\n- A fix.\n");
    expect(box.logs.at(-1)).toBe("Released 0.2.0.");
  });

  test("a dry run shows the steps and the notes and changes nothing", () => {
    const box = makeBox();
    const head = box.git("rev-parse", "HEAD");
    doRelease(box, "0.2.0", { dryRun: true });
    expect(box.logs[0]).toBe("Would release 0.2.0:");
    expect(box.logs).toContain("  1. run the gate (make check)");
    expect(box.logs.join("\n")).toContain("### Fixed\n\n- A fix.");
    expect(box.git("rev-parse", "HEAD")).toBe(head);
    expect(box.git("status", "--porcelain")).toBe("");
    expect(remoteRef(box, "refs/tags/0.2.0")).toBe("");
    expect(ghCalls(box).some((call) => call.startsWith("release create"))).toBe(false);
  });

  test("refuses to start, changing nothing, when the repository is not ready", () => {
    const box = makeBox();
    writeFileSync(path.join(box.repo, "stray.txt"), "x\n");
    box.git("checkout", "-q", "-b", "topic");
    expect(() => doRelease(box, "0.0.9")).toThrow(ReleaseError);
    try {
      doRelease(box, "0.0.9");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("the current branch is topic");
      expect(message).toContain("uncommitted changes: stray.txt");
      expect(message).toContain("0.0.9 is older than the current version 0.1.0");
    }
    expect(read(box, "VERSION")).toBe("0.1.0\n");
  });

  test("refuses when main is behind origin, when [Unreleased] is empty, or when gh is logged out", () => {
    const behind = makeBox();
    const other = path.join(behind.dir, "other");
    Bun.spawnSync(["git", "clone", "-q", behind.remote, other], { env: behind.env });
    writeFileSync(path.join(other, "new.txt"), "new\n");
    Bun.spawnSync(["git", "add", "-A"], { cwd: other, env: behind.env });
    Bun.spawnSync(["git", "commit", "-q", "-m", "someone else"], { cwd: other, env: behind.env });
    Bun.spawnSync(["git", "push", "-q", "origin", "main"], { cwd: other, env: behind.env });
    expect(() => doRelease(behind, "0.2.0")).toThrow("not level with origin/main");

    const empty = makeBox("0.1.0", CHANGELOG.replace("### Fixed\n\n- A fix.\n\n", ""));
    expect(() => doRelease(empty, "0.2.0")).toThrow("nothing under [Unreleased]");

    const loggedOut = makeBox();
    loggedOut.env.GH_LOGGED_OUT = "1";
    expect(() => doRelease(loggedOut, "0.2.0")).toThrow("not logged in");
    expect(read(loggedOut, "VERSION")).toBe("0.1.0\n");
  });

  test("a failing gate before the changes stops with nothing changed", () => {
    const box = makeBox();
    expect(() => doRelease(box, "0.2.0", { check: ["false"] })).toThrow("make check failed");
    expect(read(box, "VERSION")).toBe("0.1.0\n");
    expect(box.git("status", "--porcelain")).toBe("");
  });

  test("a gate that fails on the new version puts the release files back", () => {
    const box = makeBox();
    const check = ["sh", "-c", 'test "$(cat VERSION)" != 0.2.0'];
    expect(() => doRelease(box, "0.2.0", { check })).toThrow("back as they were");
    expect(read(box, "VERSION")).toBe("0.1.0\n");
    expect(read(box, "CHANGELOG.md")).toBe(CHANGELOG);
    expect(read(box, "dist/version.txt")).toBe("0.1.0\n");
    expect(box.git("status", "--porcelain")).toBe("");
    expect(box.git("log", "-1", "--format=%s")).toBe("initial");
  });

  test("after a rejected push, pulling and running again rebuilds on top, pushes, tags and publishes", () => {
    const box = makeBox();
    // Someone else pushes while the release runs: the remote refuses the first push.
    const hook = path.join(box.remote, "hooks", "pre-receive");
    writeFileSync(hook, `#!/bin/sh\nif [ ! -f "${box.dir}/once" ]; then touch "${box.dir}/once"; exit 1; fi\n`);
    chmodSync(hook, 0o755);
    expect(() => doRelease(box, "0.2.0")).toThrow("the push was rejected");
    expect(box.git("log", "-1", "--format=%s")).toBe("chore: release 0.2.0");
    expect(remoteRef(box, "refs/heads/main")).not.toBe(box.git("rev-parse", "HEAD"));

    const other = path.join(box.dir, "other");
    Bun.spawnSync(["git", "clone", "-q", box.remote, other], { env: box.env });
    writeFileSync(path.join(other, "new.txt"), "new\n");
    Bun.spawnSync(["git", "add", "-A"], { cwd: other, env: box.env });
    Bun.spawnSync(["git", "commit", "-q", "-m", "someone else"], { cwd: other, env: box.env });
    expect(Bun.spawnSync(["git", "push", "-q", "origin", "main"], { cwd: other, env: box.env }).exitCode).toBe(0);
    expect(() => doRelease(box, "0.2.0")).toThrow("run git pull --rebase");

    box.git("pull", "-q", "--rebase");
    box.logs.length = 0;
    doRelease(box, "0.2.0");
    expect(box.logs).toContain("  1. rebuild dist/ and amend the release commit if that changes it");
    const head = box.git("rev-parse", "HEAD");
    expect(box.git("log", "-2", "--format=%s")).toBe("chore: release 0.2.0\nsomeone else");
    expect(remoteRef(box, "refs/heads/main")).toBe(head);
    expect(remoteRef(box, "refs/tags/0.2.0^{commit}")).toBe(head);
    expect(existsSync(path.join(box.dir, "released-0.2.0"))).toBe(true);
  });

  test("a missing GitHub release is published on its own; a finished release is left alone", () => {
    const box = makeBox();
    doRelease(box, "0.2.0");
    rmSync(path.join(box.dir, "released-0.2.0"));
    rmSync(box.ghLog);
    box.logs.length = 0;
    doRelease(box, "0.2.0");
    expect(box.logs.slice(0, 2)).toEqual(["Releasing 0.2.0:", "  1. publish the GitHub release 0.2.0"]);
    expect(ghCalls(box).filter((call) => call.startsWith("release create"))).toHaveLength(1);

    box.logs.length = 0;
    doRelease(box, "0.2.0");
    expect(box.logs).toEqual(["0.2.0 is already released."]);
  });

  test("the starting version can be released once, when it has no CHANGELOG section yet", () => {
    const first = `# Changelog\n\n## [Unreleased]\n\n- The first release.\n`;
    const box = makeBox("0.1.0", first);
    doRelease(box, "0.1.0");
    expect(read(box, "CHANGELOG.md")).toContain("## [0.1.0] - 2026-11-01");
    expect(read(box, "CHANGELOG.md")).toContain("[0.1.0]: https://github.com/ecmwf/ecmwf-multi-agents/releases/tag/0.1.0");
    expect(remoteRef(box, "refs/tags/0.1.0^{commit}")).toBe(box.git("rev-parse", "HEAD"));
  });

  test("rejects a version with a v prefix", () => {
    const box = makeBox();
    expect(() => doRelease(box, "v0.2.0")).toThrow('starts with "v"');
  });
});
