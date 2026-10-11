// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  checkVersion,
  compareVersions,
  consistencyProblems,
  packageVersion,
  parseChangelog,
  releaseNotes,
  rollChangelog,
  setPackageVersion,
  setVersion,
} from "./version.ts";

const REPO = "https://example.org/repo";

const HEADER = `<!--
SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
SPDX-License-Identifier: Apache-2.0
-->

# Changelog

Intro text.
`;

const FIRST = `${HEADER}
## [Unreleased]

### Added

- The first feature.
`;

const RELEASED = `${HEADER}
## [Unreleased]

### Fixed

- A fix.

## [0.1.0] - 2026-10-11

### Added

- The first feature.

[Unreleased]: ${REPO}/compare/0.1.0...HEAD
[0.1.0]: ${REPO}/releases/tag/0.1.0
`;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function project(version: string, changelog: string, pkgVersion = version): string {
  const dir = mkdtempSync(path.join(tmpdir(), "version-test-"));
  dirs.push(dir);
  writeFileSync(path.join(dir, "VERSION"), `${version}\n`);
  writeFileSync(path.join(dir, "package.json"), `{\n  "name": "x",\n  "version": "${pkgVersion}",\n  "private": true\n}\n`);
  writeFileSync(path.join(dir, "CHANGELOG.md"), changelog);
  return dir;
}

describe("versions", () => {
  test("accepts MAJOR.MINOR.MICRO and rejects a v prefix or other shapes", () => {
    expect(checkVersion("1.2.3")).toBe("1.2.3");
    expect(checkVersion("0.10.0\n")).toBe("0.10.0");
    expect(() => checkVersion("v1.2.3")).toThrow('starts with "v"');
    expect(() => checkVersion("1.2")).toThrow("is not a version");
    expect(() => checkVersion("1.2.3-rc1")).toThrow("is not a version");
    expect(() => checkVersion("")).toThrow("is empty");
  });

  test("compares numerically, not as text", () => {
    expect(compareVersions("0.10.0", "0.9.9")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.2.3", "1.10.0")).toBeLessThan(0);
  });

  test("rewrites only the version value of package.json", () => {
    const text = `{\n  "name": "x",\n  "version": "0.1.0",\n  "scripts": { "version": "keep" }\n}\n`;
    const updated = setPackageVersion(text, "0.2.0");
    expect(updated).toBe(text.replace('"version": "0.1.0"', '"version": "0.2.0"'));
    expect(packageVersion(updated)).toBe("0.2.0");
  });
});

describe("changelog", () => {
  test("parses unreleased, release sections and link references", () => {
    const parsed = parseChangelog(RELEASED);
    expect(parsed.sections.map((s) => `${s.version} ${s.date}`)).toEqual(["0.1.0 2026-10-11"]);
    expect(parsed.lines[parsed.links]).toBe(`[Unreleased]: ${REPO}/compare/0.1.0...HEAD`);
  });

  test("rejects a missing [Unreleased], a bad heading and releases out of order", () => {
    expect(() => parseChangelog(`${HEADER}\n## [0.1.0] - 2026-10-11\n\n- x\n`)).toThrow("exactly one");
    expect(() => parseChangelog(`${HEADER}\n## [Unreleased]\n\n## 0.1.0\n`)).toThrow("is not a release heading");
    expect(() => parseChangelog(`${HEADER}\n## [Unreleased]\n\n## [0.1.0] - 2026-01-01\n\n## [0.2.0] - 2026-02-01\n`)).toThrow("newest first");
  });

  test("the first release moves the entries and links to the release tag", () => {
    const rolled = rollChangelog(FIRST, "0.1.0", "2026-10-11", REPO);
    expect(rolled).toBe(`${HEADER}
## [Unreleased]

## [0.1.0] - 2026-10-11

### Added

- The first feature.

[Unreleased]: ${REPO}/compare/0.1.0...HEAD
[0.1.0]: ${REPO}/releases/tag/0.1.0
`);
  });

  test("a later release links the comparison with the previous one and keeps older sections", () => {
    const rolled = rollChangelog(RELEASED, "0.2.0", "2026-11-01", REPO);
    expect(rolled).toBe(`${HEADER}
## [Unreleased]

## [0.2.0] - 2026-11-01

### Fixed

- A fix.

## [0.1.0] - 2026-10-11

### Added

- The first feature.

[Unreleased]: ${REPO}/compare/0.2.0...HEAD
[0.2.0]: ${REPO}/compare/0.1.0...0.2.0
[0.1.0]: ${REPO}/releases/tag/0.1.0
`);
    expect(parseChangelog(rolled).sections.map((s) => s.version)).toEqual(["0.2.0", "0.1.0"]);
  });

  test("refuses an empty [Unreleased], an existing or older version and a bad date", () => {
    const empty = rollChangelog(RELEASED, "0.2.0", "2026-11-01", REPO);
    expect(() => rollChangelog(empty, "0.3.0", "2026-12-01", REPO)).toThrow("nothing under");
    expect(() => rollChangelog(RELEASED, "0.1.0", "2026-11-01", REPO)).toThrow("already has a section");
    expect(() => rollChangelog(RELEASED, "0.0.9", "2026-11-01", REPO)).toThrow("not newer");
    expect(() => rollChangelog(RELEASED, "0.2.0", "1 Nov 2026", REPO)).toThrow("the date");
  });

  test("release notes are the section body without its heading", () => {
    expect(releaseNotes(RELEASED, "0.1.0")).toBe("### Added\n\n- The first feature.\n");
    expect(() => releaseNotes(RELEASED, "0.9.0")).toThrow("no section for 0.9.0");
    expect(() => releaseNotes(`${HEADER}\n## [Unreleased]\n\n## [0.1.0] - 2026-10-11\n`, "0.1.0")).toThrow("is empty");
  });
});

describe("files", () => {
  test("consistent files have no problems; a package.json mismatch is reported", () => {
    expect(consistencyProblems(project("0.1.0", RELEASED))).toEqual([]);
    expect(consistencyProblems(project("0.1.0", RELEASED, "0.0.9"))).toEqual([
      "package.json says 0.0.9 but VERSION says 0.1.0; set it to the same value",
    ]);
  });

  test("a bad VERSION, a broken changelog and a changelog ahead of VERSION are reported", () => {
    const dir = project("0.1.0", RELEASED);
    writeFileSync(path.join(dir, "VERSION"), "v0.1.0\n");
    expect(consistencyProblems(dir)[0]).toContain('starts with "v"');
    expect(consistencyProblems(project("0.1.0", `${HEADER}\n- no headings\n`))[0]).toContain("exactly one");
    expect(consistencyProblems(project("0.0.5", RELEASED, "0.0.5"))).toEqual([
      "CHANGELOG.md has a release 0.1.0 newer than VERSION (0.0.5)",
    ]);
  });

  test("setting a version writes VERSION, package.json and the changelog", () => {
    const dir = project("0.1.0", RELEASED);
    expect(setVersion(dir, "0.2.0", "2026-11-01")).toEqual([
      "VERSION: 0.1.0 -> 0.2.0",
      "package.json: version 0.2.0",
      "CHANGELOG.md: [Unreleased] moved under [0.2.0] - 2026-11-01",
    ]);
    expect(readFileSync(path.join(dir, "VERSION"), "utf8")).toBe("0.2.0\n");
    expect(packageVersion(readFileSync(path.join(dir, "package.json"), "utf8"))).toBe("0.2.0");
    expect(releaseNotes(readFileSync(path.join(dir, "CHANGELOG.md"), "utf8"), "0.2.0")).toBe("### Fixed\n\n- A fix.\n");
    expect(consistencyProblems(dir)).toEqual([]);
  });

  test("the current version can be released once: the first release of the starting version", () => {
    const dir = project("0.1.0", FIRST);
    expect(setVersion(dir, "0.1.0", "2026-10-11")).toEqual(["CHANGELOG.md: [Unreleased] moved under [0.1.0] - 2026-10-11"]);
    expect(setVersion(dir, "0.1.0", "2026-10-11")).toEqual([]);
  });

  test("going backwards is refused and changes nothing", () => {
    const dir = project("0.2.0", RELEASED);
    const before = readFileSync(path.join(dir, "CHANGELOG.md"), "utf8");
    expect(() => setVersion(dir, "0.1.5", "2026-11-01")).toThrow("must be newer than the current version 0.2.0");
    expect(() => setVersion(dir, "0.1.0", "2026-11-01")).toThrow("must be newer than the current version 0.2.0");
    expect(readFileSync(path.join(dir, "VERSION"), "utf8")).toBe("0.2.0\n");
    expect(readFileSync(path.join(dir, "CHANGELOG.md"), "utf8")).toBe(before);
  });
});
