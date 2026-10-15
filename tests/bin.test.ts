// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

// The npm package's command, bin/ecmwf-multi-agents.js, run as npm installs it: through a
// symlink in another folder. Only --help and an unknown option are run, which touch nothing.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
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

function run(argv: string[]) {
  const result = Bun.spawnSync(argv, { cwd: box, stdout: "pipe", stderr: "pipe" });
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
    expect(err).toContain("unknown option: --no-such-option");
  });

  test("runs by its shebang, also through a chain of symlinks", () => {
    const first = linked("first");
    const { code, out } = run([linked("second", first), "--help"]);
    expect(code).toBe(0);
    expect(out).toContain("Usage:");
  });
});
