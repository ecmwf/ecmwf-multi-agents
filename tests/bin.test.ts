// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

// The npm package's command, bin/ecmwf-multi-agents.js, run as npm installs it: through a
// symlink in another folder. Only --help, an unknown option and dry runs against a fake opencode
// are run, which touch nothing.

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const WRAPPER = path.join(ROOT, "bin", "ecmwf-multi-agents.js");
const node = Bun.which("node");

const box = mkdtempSync(path.join(tmpdir(), "ecmwf-multi-agents-bin-"));
afterAll(() => rmSync(box, { recursive: true, force: true }));

/** A symlink to the wrapper in a folder of its own, as npm's global bin folder holds it. */
function linked(name: string, target = WRAPPER): string {
  const dir = path.join(box, name);
  mkdirSync(dir, { recursive: true });
  const link = path.join(dir, "ecmwf-multi-agents");
  symlinkSync(target, link);
  return link;
}

function run(argv: string[], env?: Record<string, string>) {
  const result = Bun.spawnSync(argv, { cwd: box, env, stdout: "pipe", stderr: "pipe" });
  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
}

describe.skipIf(node === null)("the npm command", () => {
  test("run through a symlink, it runs install.sh from the package folder", () => {
    const { code, out } = run([node!, linked("once"), "--help"]);
    expect(code).toBe(0);
    expect(out).toContain("Usage:");
    expect(out).toContain("--project");
  });

  test("passes the arguments on and returns install.sh's exit code and error", () => {
    const { code, err } = run([node!, linked("args"), "--no-such-option"]);
    expect(code).toBe(1);
    expect(err).toContain("unknown option: --no-such-option (see ecmwf-multi-agents --help)");
  });

  test("messages name the command the user ran, not install.sh", () => {
    const { out } = run([node!, linked("name"), "--help"]);
    expect(out).toContain("Usage: ecmwf-multi-agents [command] [options]");
    expect(out).toContain("  ecmwf-multi-agents doctor\n");
    expect(out).not.toContain("install.sh");
  });

  test("runs by its shebang, also through a chain of symlinks", () => {
    const first = linked("first");
    const { code, out } = run([linked("second", first), "--help"]);
    expect(code).toBe(0);
    expect(out).toContain("Usage:");
  });

  test("run by npx, an install copies the files unless --link or --copy is given", () => {
    const pinned = /^V2_PINNED=(\S+)$/m.exec(readFileSync(path.join(ROOT, "install.sh"), "utf8"))![1]!;
    const bin = path.join(box, "npx-bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(path.join(bin, "opencode"), `#!/bin/sh\nprintf '%s\\n' 'opencode v${pinned}'\n`);
    chmodSync(path.join(bin, "opencode"), 0o755);
    const home = path.join(box, "npx-home");
    mkdirSync(home, { recursive: true });
    const env = (npm: Record<string, string>) => ({ HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), PATH: `${bin}:/usr/bin:/bin`, TMPDIR: box, ...npm });
    const npx = env({ npm_command: "exec" });
    const wrapper = linked("npx");
    const copied = run([node!, wrapper, "--dry-run"], npx);
    expect(copied.code).toBe(0);
    expect(copied.out).toContain("(files copied)");
    expect(run([node!, wrapper, "install", "--dry-run"], npx).out).toContain("(files copied)");
    expect(run([node!, wrapper, "--dry-run", "--link"], npx).out).toContain("(files linked to this checkout)");
    expect(run([node!, wrapper, "--dry-run"], env({})).out).toContain("(files linked to this checkout)");
    expect(existsSync(path.join(home, ".config"))).toBe(false);
  });
});
