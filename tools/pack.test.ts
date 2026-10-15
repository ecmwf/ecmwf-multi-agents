// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Manifest, checkPackage, packProblems } from "./pack.ts";

const MANIFEST: Manifest = {
  files: ["dist", "install.sh", "VERSION"],
  bin: { tool: "bin/tool.js" },
  exports: { "./server": "./dist/opencode-v2/plugins/tool.js" },
};

const TRACKED = [
  ".gitignore",
  "Makefile",
  "VERSION",
  "bin/tool.js",
  "dist/opencode-v2/agents/lead.md",
  "dist/opencode-v2/plugins/tool.js",
  "dist/opencode-v2/skills/plan/SKILL.md",
  "install.sh",
  "package.json",
  "src/agents/lead.md",
];

const PACKED = [
  "VERSION",
  "bin/tool.js",
  "dist/opencode-v2/agents/lead.md",
  "dist/opencode-v2/plugins/tool.js",
  "dist/opencode-v2/skills/plan/SKILL.md",
  "install.sh",
  "package.json",
];

describe("the files of the npm package", () => {
  test("npm packs exactly the package's files that git tracks", () => {
    expect(packProblems(PACKED, MANIFEST, TRACKED)).toEqual([]);
  });

  test('paths in package.json may start with "./" or end with "/"', () => {
    const manifest = { ...MANIFEST, files: ["./dist/", "install.sh", "VERSION"], bin: "./bin/tool.js" };
    expect(packProblems(PACKED, manifest, TRACKED)).toEqual([]);
  });

  test("a file npm would leave out, as an ignore file inside dist/ makes it", () => {
    const packed = PACKED.filter((file) => file !== "dist/opencode-v2/agents/lead.md");
    expect(packProblems(packed, MANIFEST, TRACKED)).toEqual(["npm would leave out dist/opencode-v2/agents/lead.md"]);
  });

  test("a file npm would add that git does not track, such as one left in dist/", () => {
    const packed = [...PACKED, "dist/opencode-v2/notes.log"];
    expect(packProblems(packed, MANIFEST, TRACKED)).toEqual(["npm would add dist/opencode-v2/notes.log, which git does not track"]);
  });

  test('a "files" entry git does not track', () => {
    const manifest = { ...MANIFEST, files: ["dist", "install.sh", "VERSION", "LICENSE"] };
    expect(packProblems(PACKED, manifest, TRACKED)).toEqual(['package.json "files" names LICENSE, which git does not track']);
  });

  test("a file the package needs that is no longer in its files", () => {
    const manifest = { ...MANIFEST, files: ["dist", "VERSION"] };
    const packed = PACKED.filter((file) => file !== "install.sh");
    expect(packProblems(packed, manifest, TRACKED)).toEqual(["npm would not pack install.sh, which the package needs"]);
  });

  test('an "exports" target npm would not pack', () => {
    const manifest = { ...MANIFEST, exports: { "./server": "./dist/opencode-v2/plugins/other.js" } };
    expect(packProblems(PACKED, manifest, TRACKED)).toEqual(['"exports" names dist/opencode-v2/plugins/other.js, which npm would not pack']);
  });

  test('no "files" list', () => {
    expect(packProblems(PACKED, { bin: MANIFEST.bin }, TRACKED)[0]).toBe('package.json has no "files" list');
  });
});

// npm's own rules, on a small git repository shaped like this one.
describe.skipIf(Bun.which("npm") === null || Bun.which("git") === null)("npm pack on a small package", () => {
  const box = mkdtempSync(path.join(tmpdir(), "ecmwf-multi-agents-pack-"));
  const write = (file: string, text = "text\n") => {
    mkdirSync(path.dirname(path.join(box, file)), { recursive: true });
    writeFileSync(path.join(box, file), text);
  };

  beforeAll(() => {
    write("package.json", `${JSON.stringify({ name: "pack-check-sample", version: "1.0.0", files: MANIFEST.files, bin: MANIFEST.bin })}\n`);
    for (const file of TRACKED.filter((file) => file !== "package.json")) write(file);
    for (const argv of [["git", "init", "-q"], ["git", "add", "-A"]]) {
      expect(Bun.spawnSync(argv, { cwd: box, stdout: "pipe", stderr: "pipe" }).exitCode).toBe(0);
    }
  });
  afterAll(() => rmSync(box, { recursive: true, force: true }));

  test("npm packs the files git tracks", () => {
    expect(checkPackage(box)).toEqual({ packed: PACKED.length, problems: [] });
  });

  test("npm packs a file left in dist/ that git does not track", () => {
    write("dist/opencode-v2/stray.txt");
    try {
      expect(checkPackage(box).problems).toEqual(["npm would add dist/opencode-v2/stray.txt, which git does not track"]);
    } finally {
      rmSync(path.join(box, "dist/opencode-v2/stray.txt"));
    }
  });

  test("npm leaves out a folder whose own .gitignore ignores everything, as wasm-pack writes one", () => {
    write("dist/opencode-v2/.gitignore", "*\n");
    try {
      expect(checkPackage(box).problems).toEqual([
        "npm would leave out dist/opencode-v2/agents/lead.md",
        "npm would leave out dist/opencode-v2/plugins/tool.js",
        "npm would leave out dist/opencode-v2/skills/plan/SKILL.md",
        "npm would not pack dist/opencode-v2/, which the package needs",
      ]);
    } finally {
      rmSync(path.join(box, "dist/opencode-v2/.gitignore"));
    }
  });
});
