// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

// The project version. The VERSION file at the repository root is the single source: a
// version is MAJOR.MINOR.MICRO without a "v" prefix, and the release tag is exactly that
// string. package.json carries a copy, and CHANGELOG.md has one section per release.
//
//   bun tools/version.ts                 print the version; exit 1 if the files disagree
//   bun tools/version.ts --check         check VERSION, package.json and CHANGELOG.md agree
//   bun tools/version.ts --set X.Y.Z [--date YYYY-MM-DD]
//                                        set the version and move [Unreleased] under it
//   bun tools/version.ts --notes X.Y.Z   print the CHANGELOG section of a release
//   bun tools/version.ts --preflight     check the repository is ready to tag VERSION
//
// The generator embeds the version in dist/, so run `bun tools/build.ts` after --set
// (`make version X.Y.Z` does both).

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { VERSION_FILE, parseVersion } from "./load.ts";

export const REPOSITORY = "https://github.com/ecmwf/ecmwf-multi-agents";
export const CHANGELOG_FILE = "CHANGELOG.md";
export const PACKAGE_FILE = "package.json";

const UNRELEASED = "## [Unreleased]";
const RELEASE_HEADING = /^## \[(\d+\.\d+\.\d+)\] - (\d{4}-\d{2}-\d{2})$/;
const LINK_REFERENCE = /^\[[^\]]+\]: \S+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export class VersionError extends Error {}

function fail(message: string): never {
  throw new VersionError(message);
}

/** Parse a version string, or explain what is wrong with it. */
export function checkVersion(text: string): string {
  const parsed = parseVersion(text);
  if ("problem" in parsed) fail(`${text.trim() === "" ? "the version" : JSON.stringify(text.trim())}: ${parsed.problem}`);
  return parsed.version;
}

/** Negative, zero or positive as a is lower than, equal to or higher than b. */
export function compareVersions(a: string, b: string): number {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** The "version" value of a package.json text. */
export function packageVersion(text: string): string {
  const value = (JSON.parse(text) as { version?: unknown }).version;
  if (typeof value !== "string") fail(`${PACKAGE_FILE} has no "version" string`);
  return value;
}

/** Replace the top-level "version" value of a package.json text, keeping its formatting. */
export function setPackageVersion(text: string, version: string): string {
  const pattern = /^(\s*"version"\s*:\s*")([^"]*)(")/m;
  if (!pattern.test(text)) fail(`${PACKAGE_FILE} has no "version" line`);
  const updated = text.replace(pattern, `$1${version}$3`);
  if (packageVersion(updated) !== version) fail(`could not set the version in ${PACKAGE_FILE}`);
  return updated;
}

interface Section {
  version: string;
  date: string;
  /** Line index of the heading. */
  start: number;
  /** Line index after the last line of the section body. */
  end: number;
}

interface Parsed {
  lines: string[];
  unreleased: { start: number; end: number };
  sections: Section[];
  /** Line index where the link references at the bottom begin (lines.length if none). */
  links: number;
}

/** Split a changelog into its [Unreleased] section, release sections and link references. */
export function parseChangelog(text: string): Parsed {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let links = lines.length;
  while (links > 0 && (lines[links - 1]!.trim() === "" || LINK_REFERENCE.test(lines[links - 1]!))) links--;
  while (links < lines.length && !LINK_REFERENCE.test(lines[links]!)) links++;

  const headings: number[] = [];
  for (let i = 0; i < links; i++) if (lines[i]!.startsWith("## ")) headings.push(i);
  const unreleasedAt = headings.filter((i) => lines[i] === UNRELEASED);
  if (unreleasedAt.length !== 1) fail(`${CHANGELOG_FILE} must have exactly one "${UNRELEASED}" heading`);
  if (headings[0] !== unreleasedAt[0]) fail(`${CHANGELOG_FILE}: "${UNRELEASED}" must be the first section`);

  const endOf = (k: number) => (k + 1 < headings.length ? headings[k + 1]! : links);
  const sections: Section[] = [];
  for (let k = 1; k < headings.length; k++) {
    const line = lines[headings[k]!]!;
    const match = RELEASE_HEADING.exec(line);
    if (!match) fail(`${CHANGELOG_FILE}: "${line}" is not a release heading such as "## [1.2.3] - 2026-01-31"`);
    sections.push({ version: match[1]!, date: match[2]!, start: headings[k]!, end: endOf(k) });
  }
  for (let k = 1; k < sections.length; k++) {
    if (compareVersions(sections[k - 1]!.version, sections[k]!.version) <= 0) {
      fail(`${CHANGELOG_FILE}: releases must be listed newest first; ${sections[k - 1]!.version} comes before ${sections[k]!.version}`);
    }
  }
  return { lines, unreleased: { start: headings[0]!, end: endOf(0) }, sections, links };
}

function body(lines: string[], start: number, end: number): string[] {
  const out = lines.slice(start, end);
  while (out.length > 0 && out[0]!.trim() === "") out.shift();
  while (out.length > 0 && out[out.length - 1]!.trim() === "") out.pop();
  return out;
}

/** The body of a release section, without its heading. */
export function releaseNotes(text: string, version: string): string {
  const parsed = parseChangelog(text);
  const section = parsed.sections.find((s) => s.version === version);
  if (!section) fail(`${CHANGELOG_FILE} has no section for ${version}`);
  const lines = body(parsed.lines, section.start + 1, section.end);
  if (lines.length === 0) fail(`${CHANGELOG_FILE}: the section for ${version} is empty`);
  return `${lines.join("\n")}\n`;
}

/** Move the [Unreleased] entries under a new release heading and update the link references. */
export function rollChangelog(text: string, version: string, date: string, repository = REPOSITORY): string {
  checkVersion(version);
  if (!DATE.test(date)) fail(`the date must look like 2026-01-31, got ${JSON.stringify(date)}`);
  const parsed = parseChangelog(text);
  if (parsed.sections.some((s) => s.version === version)) fail(`${CHANGELOG_FILE} already has a section for ${version}`);
  const latest = parsed.sections[0]?.version;
  if (latest !== undefined && compareVersions(version, latest) <= 0) {
    fail(`${version} is not newer than the latest release in ${CHANGELOG_FILE}, ${latest}`);
  }
  const entries = body(parsed.lines, parsed.unreleased.start + 1, parsed.unreleased.end);
  if (entries.length === 0) fail(`nothing under "${UNRELEASED}" in ${CHANGELOG_FILE}: describe the changes of ${version} there first`);

  const before = parsed.lines.slice(0, parsed.unreleased.start + 1);
  const rest = parsed.lines.slice(parsed.unreleased.end, parsed.links);
  while (rest.length > 0 && rest[rest.length - 1]!.trim() === "") rest.pop();
  const sections = [...before, "", `## [${version}] - ${date}`, "", ...entries, ...(rest.length > 0 ? ["", ...rest] : [])];

  const links = parsed.lines.slice(parsed.links).filter((line) => LINK_REFERENCE.test(line));
  const kept = links.filter((line) => !line.startsWith("[Unreleased]: ") && !line.startsWith(`[${version}]: `));
  const added = [
    `[Unreleased]: ${repository}/compare/${version}...HEAD`,
    latest === undefined ? `[${version}]: ${repository}/releases/tag/${version}` : `[${version}]: ${repository}/compare/${latest}...${version}`,
  ];
  return `${[...sections, "", ...added, ...kept].join("\n")}\n`;
}

/** Problems with the agreement of VERSION, package.json and CHANGELOG.md; empty when all is well. */
export function consistencyProblems(root: string): string[] {
  const problems: string[] = [];
  const read = (file: string): string | undefined => {
    try {
      return readFileSync(path.join(root, file), "utf8");
    } catch {
      problems.push(`${file} is missing`);
      return undefined;
    }
  };
  const versionText = read(VERSION_FILE);
  const packageText = read(PACKAGE_FILE);
  const changelog = read(CHANGELOG_FILE);
  let version: string | undefined;
  if (versionText !== undefined) {
    const parsed = parseVersion(versionText);
    if ("problem" in parsed) problems.push(`${VERSION_FILE} ${parsed.problem}`);
    else version = parsed.version;
  }
  if (packageText !== undefined && version !== undefined) {
    try {
      const value = packageVersion(packageText);
      if (value !== version) problems.push(`${PACKAGE_FILE} says ${value} but ${VERSION_FILE} says ${version}; run make version ${version}`);
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (changelog !== undefined) {
    try {
      const parsed = parseChangelog(changelog);
      const latest = parsed.sections[0]?.version;
      if (version !== undefined && latest !== undefined && compareVersions(latest, version) > 0) {
        problems.push(`${CHANGELOG_FILE} has a release ${latest} newer than ${VERSION_FILE} (${version})`);
      }
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
  }
  return problems;
}

/** Set the version: VERSION, package.json and the changelog. Returns what changed, for the log. */
export function setVersion(root: string, version: string, date: string): string[] {
  checkVersion(version);
  const versionPath = path.join(root, VERSION_FILE);
  const current = checkVersion(readFileSync(versionPath, "utf8"));
  const changelogPath = path.join(root, CHANGELOG_FILE);
  const changelog = readFileSync(changelogPath, "utf8");
  const released = parseChangelog(changelog).sections.some((s) => s.version === version);
  // The current version may be set again: that releases it once (the starting version of a
  // project has no changelog section yet), and is a no-op after that.
  const order = compareVersions(version, current);
  if (order < 0) fail(`${version} must be newer than the current version ${current}`);
  const changes: string[] = [];
  if (order > 0) {
    writeFileSync(versionPath, `${version}\n`);
    changes.push(`${VERSION_FILE}: ${current} -> ${version}`);
  }
  const packagePath = path.join(root, PACKAGE_FILE);
  const packageText = readFileSync(packagePath, "utf8");
  if (packageVersion(packageText) !== version) {
    writeFileSync(packagePath, setPackageVersion(packageText, version));
    changes.push(`${PACKAGE_FILE}: version ${version}`);
  }
  if (!released) {
    writeFileSync(changelogPath, rollChangelog(changelog, version, date));
    changes.push(`${CHANGELOG_FILE}: [Unreleased] moved under [${version}] - ${date}`);
  }
  return changes;
}

function git(root: string, args: string[]): { ok: boolean; out: string } {
  const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  return { ok: result.exitCode === 0, out: result.stdout.toString().trim() };
}

/** Problems that stop tagging VERSION as a release; empty when ready. Needs git and network. */
export function preflightProblems(root: string): string[] {
  const problems = consistencyProblems(root);
  if (problems.length > 0) return problems;
  const version = checkVersion(readFileSync(path.join(root, VERSION_FILE), "utf8"));
  try {
    releaseNotes(readFileSync(path.join(root, CHANGELOG_FILE), "utf8"), version);
  } catch (error) {
    problems.push(`${error instanceof Error ? error.message : String(error)}; run make version ${version} first`);
  }
  const branch = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]).out;
  if (branch !== "main") problems.push(`releases are tagged on main, but the current branch is ${branch}`);
  if (git(root, ["status", "--porcelain"]).out !== "") problems.push("the working tree has uncommitted changes");
  if (!git(root, ["fetch", "--quiet", "origin"]).ok) problems.push("git fetch origin failed");
  const head = git(root, ["rev-parse", "HEAD"]).out;
  const remote = git(root, ["rev-parse", "origin/main"]).out;
  if (head !== remote) problems.push("HEAD is not origin/main: push the release commit first, or pull");
  if (git(root, ["rev-parse", "-q", "--verify", `refs/tags/${version}`]).ok) problems.push(`the tag ${version} already exists here`);
  if (git(root, ["ls-remote", "--tags", "origin", `refs/tags/${version}`]).out !== "") problems.push(`the tag ${version} already exists on origin`);
  if (Bun.spawnSync(["gh", "auth", "status"], { stdout: "ignore", stderr: "ignore" }).exitCode !== 0) {
    problems.push("gh is not logged in to GitHub (gh auth login)");
  }
  return problems;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function main(argv: string[]): number {
  const root = path.resolve(import.meta.dir, "..");
  const [command, value, ...rest] = argv;
  const report = (problems: string[]): number => {
    for (const problem of problems) console.error(`error: ${problem}`);
    return problems.length === 0 ? 0 : 1;
  };
  switch (command) {
    case undefined: {
      const problems = consistencyProblems(root);
      if (problems.length === 0) console.log(readFileSync(path.join(root, VERSION_FILE), "utf8").trim());
      return report(problems);
    }
    case "--check": {
      const problems = consistencyProblems(root);
      if (problems.length === 0) console.log(`version ${readFileSync(path.join(root, VERSION_FILE), "utf8").trim()}: VERSION, package.json and CHANGELOG.md agree`);
      return report(problems);
    }
    case "--set": {
      if (value === undefined) return report(["usage: bun tools/version.ts --set X.Y.Z [--date YYYY-MM-DD]"]);
      let date = today();
      if (rest[0] === "--date") {
        if (rest[1] === undefined) return report(["--date needs a value such as 2026-01-31"]);
        date = rest[1];
      } else if (rest.length > 0) {
        return report([`unexpected argument: ${rest[0]}`]);
      }
      const changes = setVersion(root, value, date);
      for (const change of changes) console.log(change);
      if (changes.length === 0) console.log(`version ${value} is already set and released in ${CHANGELOG_FILE}`);
      return 0;
    }
    case "--notes": {
      if (value === undefined) return report(["usage: bun tools/version.ts --notes X.Y.Z"]);
      process.stdout.write(releaseNotes(readFileSync(path.join(root, CHANGELOG_FILE), "utf8"), checkVersion(value)));
      return 0;
    }
    case "--preflight": {
      const problems = preflightProblems(root);
      if (problems.length === 0) console.log(`ready to release ${readFileSync(path.join(root, VERSION_FILE), "utf8").trim()}`);
      return report(problems);
    }
    default:
      return report([`unknown argument: ${command}; see the comment at the top of tools/version.ts`]);
  }
}

if (import.meta.main) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    if (error instanceof VersionError) {
      console.error(`error: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
}
