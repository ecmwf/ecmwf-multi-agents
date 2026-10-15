// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

// The files of the npm package. `make pack-check` (`bun tools/pack.ts`) compares the files
// `npm pack` would put in the package with the ones git tracks for it. `make release` runs it
// before anything is pushed, and the release workflow before `npm publish`; both work on a
// clean checkout, where the tracked files are the files on disk.
//
//   - npm packs package.json, the bin and main targets, and every file git tracks under an
//     entry of package.json's "files", and nothing else. A .gitignore or .npmignore inside a
//     folder that "files" names makes npm leave files out, and npm packs any file left in such
//     a folder that git does not track.
//   - Each "files" entry names something git tracks, and npm packs the "exports" targets and
//     what the package cannot work without: its command runs install.sh, which reads VERSION
//     and links the files under dist/opencode-v2/.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/** Files, and folders ending in "/", that the package cannot work without. */
export const REQUIRED = ["package.json", "install.sh", "VERSION", "dist/opencode-v2/"];

export class PackError extends Error {}

/** The package.json fields that decide what npm packs. */
export interface Manifest {
  files?: unknown;
  bin?: unknown;
  main?: unknown;
  exports?: unknown;
}

/** A path from package.json as npm lists it: no leading "./", no trailing "/". */
function relative(target: string): string {
  return path.posix.normalize(target).replace(/^\.\//, "").replace(/\/$/, "");
}

/** The paths a bin, main or exports field names, nested conditions included, patterns left out. */
function targets(field: unknown): string[] {
  if (typeof field === "string") return field.includes("*") ? [] : [relative(field)];
  if (field === null || typeof field !== "object") return [];
  return Object.values(field).flatMap(targets);
}

/** What is wrong with the files npm would pack, given package.json and the files git tracks. */
export function packProblems(packed: string[], manifest: Manifest, tracked: string[]): string[] {
  const problems: string[] = [];
  const entries = Array.isArray(manifest.files) ? manifest.files.filter((entry): entry is string => typeof entry === "string") : [];
  if (entries.length === 0) problems.push('package.json has no "files" list');

  const expected = new Set(["package.json", ...targets(manifest.bin), ...targets(manifest.main)]);
  for (const entry of entries.map(relative)) {
    const under = tracked.filter((file) => file === entry || file.startsWith(`${entry}/`));
    if (under.length === 0) problems.push(`package.json "files" names ${entry}, which git does not track`);
    for (const file of under) expected.add(file);
  }

  const have = new Set(packed);
  for (const file of [...expected].sort()) {
    if (!have.has(file)) problems.push(`npm would leave out ${file}`);
  }
  for (const file of [...have].sort()) {
    if (!expected.has(file)) problems.push(`npm would add ${file}, which git does not track`);
  }
  for (const target of targets(manifest.exports)) {
    if (!have.has(target)) problems.push(`"exports" names ${target}, which npm would not pack`);
  }
  for (const need of REQUIRED) {
    const found = need.endsWith("/") ? packed.some((file) => file.startsWith(need)) : have.has(need);
    if (!found) problems.push(`npm would not pack ${need}, which the package needs`);
  }
  return problems;
}

function run(argv: string[], root: string): string {
  const result = Bun.spawnSync(argv, {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, npm_config_update_notifier: "false" },
  });
  if (result.exitCode !== 0) {
    const err = result.stderr.toString().trim();
    throw new PackError(`${argv.join(" ")} failed${err ? `: ${err}` : ""}`);
  }
  return result.stdout.toString();
}

/** The files `npm pack` would put in the package of the repository at root. */
export function packedFiles(root: string): string[] {
  if (Bun.which("npm") === null) throw new PackError("npm was not found; the package check needs npm, which comes with Node.js");
  const out = run(["npm", "pack", "--dry-run", "--json", "--ignore-scripts"], root);
  let listed: unknown;
  try {
    listed = (JSON.parse(out) as Array<{ files?: unknown }>)[0]?.files;
  } catch {
    throw new PackError(`npm pack did not print its file list as JSON: ${out.trim().slice(0, 200)}`);
  }
  if (!Array.isArray(listed)) throw new PackError("npm pack did not list the package's files");
  return listed.map((file) => String((file as { path?: unknown }).path)).sort();
}

/** The files git tracks in the repository at root, staged ones included, that are on disk. */
export function trackedFiles(root: string): string[] {
  return run(["git", "ls-files", "-z"], root)
    .split("\0")
    .filter((file) => file !== "" && existsSync(path.join(root, file)));
}

/** Check the npm package of the repository at root. */
export function checkPackage(root: string): { packed: number; problems: string[] } {
  const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as Manifest;
  const packed = packedFiles(root);
  return { packed: packed.length, problems: packProblems(packed, manifest, trackedFiles(root)) };
}

if (import.meta.main) {
  try {
    const { packed, problems } = checkPackage(path.resolve(import.meta.dir, ".."));
    if (problems.length > 0) {
      console.error(`error: the npm package is not as expected:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`);
      process.exit(1);
    }
    console.log(`npm would pack ${packed} files, as expected.`);
  } catch (error) {
    if (error instanceof PackError) {
      console.error(`error: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
}
