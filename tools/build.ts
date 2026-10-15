// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

// The generator. `bun tools/build.ts` loads and checks src/, runs each platform's emitter, adds
// the plugin bundle and the support files, and writes dist/<platform>/, removing files the build
// no longer produces. `bun tools/build.ts --check` writes nothing and fails when dist/ differs
// from what a build would write, so `make check` catches an out-of-date dist/.

import { lstat, mkdir, readdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { emitV2 } from "./emit-v2.ts";
import { load } from "./load.ts";
import { checkHarness, resolveHarness, type SizeRow, sizeTable } from "./resolve.ts";
import { settingsSchema } from "./schema.ts";
import type { Emitter, OutputFile, Profile, ProfileAgent, ResolvedHarness } from "./types.ts";
import { compareBytes, errorCode, GeneratorError, normalizeContent, own, unsafePathReason } from "./util.ts";

/** Support files for the installer and doctor live in this directory of each platform. */
export const SUPPORT_DIR = "ecmwf-multi-agents";
export const FILES_LIST = `${SUPPORT_DIR}/files.txt`;

export interface BuildOptions {
  /** Repository root: the directory that holds src/ and dist/. */
  root: string;
  /** Platform directory name, such as "opencode-v2", to the emitter for that platform. */
  emitters: Record<string, Emitter>;
  /** Files added to every platform, such as the plugin bundle. */
  extras?: (harness: ResolvedHarness) => Promise<OutputFile[]>;
  /** Write nothing; fail when dist/ differs from what a build would write. */
  check: boolean;
  log?: (line: string) => void;
}

export interface PlatformResult {
  platform: string;
  /** Every file of dist/<platform>/, files.txt included, normalised, in byte order of path. */
  files: OutputFile[];
  /** Files created or changed. Always empty in check mode. */
  written: string[];
  /** Files deleted because the build no longer produces them. Always empty in check mode. */
  removed: string[];
}

export interface BuildResult {
  harness: ResolvedHarness;
  sizes: SizeRow[];
  platforms: PlatformResult[];
}

// ---------------------------------------------------------------------------------------------
// Support files

/**
 * A profile as the installer reads it: keys id, description and agents in that order, agents in
 * manifest order, model before effort, one key per line.
 */
export function profileJson(harness: ResolvedHarness, profile: Profile): string {
  const agents: Record<string, ProfileAgent> = {};
  for (const agent of harness.agents) {
    const choice = own(profile.agents, agent.id);
    if (choice === undefined) continue;
    const entry: ProfileAgent = {};
    if (choice.model !== undefined) entry.model = choice.model;
    if (choice.effort !== undefined) entry.effort = choice.effort;
    agents[agent.id] = entry;
  }
  return JSON.stringify({ id: profile.id, description: profile.description, agents }, null, 2);
}

/** The settings schema and one file per profile. files.txt is added per platform. */
export function supportFiles(harness: ResolvedHarness): OutputFile[] {
  return [
    { path: `${SUPPORT_DIR}/schema.json`, content: JSON.stringify(settingsSchema(harness), null, 2) },
    ...harness.profiles.map((profile) => ({
      path: `${SUPPORT_DIR}/profiles/${profile.id}.json`,
      content: profileJson(harness, profile),
    })),
  ];
}

// ---------------------------------------------------------------------------------------------
// Assembling a platform

export interface FileGroup {
  /** Who produced the files, for messages: "emitter opencode-v2", "extras", "support files". */
  origin: string;
  files: readonly OutputFile[];
}

function isOutputFile(value: unknown): value is OutputFile {
  if (typeof value !== "object" || value === null) return false;
  const file = value as Record<string, unknown>;
  return typeof file.path === "string" && typeof file.content === "string";
}

/**
 * One platform's files: every group's files with checked paths and normalised content (LF line
 * endings, one trailing newline), plus files.txt, all in byte order of path. Throws listing every
 * unsafe path, every path written twice and every clash between a file and a directory.
 */
export function platformFiles(platform: string, groups: readonly FileGroup[]): OutputFile[] {
  const problems: string[] = [];
  const entries: { file: OutputFile; origin: string }[] = [];
  for (const group of groups) {
    for (const file of group.files as readonly unknown[]) {
      if (isOutputFile(file)) entries.push({ file, origin: group.origin });
      else problems.push(`${platform}: ${group.origin}: ${JSON.stringify(file) ?? String(file)} is not a {path, content} file`);
    }
  }
  entries.push({ file: { path: FILES_LIST, content: "" }, origin: "support files" });

  const origins = new Map<string, string>();
  const lowercase = new Map<string, string>();
  for (const { file, origin } of entries) {
    const shown = JSON.stringify(file.path);
    const reason = unsafePathReason(file.path);
    if (reason !== undefined) {
      problems.push(`${platform}: ${origin}: path ${shown} ${reason}`);
      continue;
    }
    const first = origins.get(file.path);
    if (first !== undefined) {
      problems.push(`${platform}: path ${shown} is written ${first === origin ? `twice by ${origin}` : `by both ${first} and ${origin}`}`);
      continue;
    }
    const twin = lowercase.get(file.path.toLowerCase());
    if (twin !== undefined) {
      problems.push(`${platform}: ${origin}: path ${shown} differs from ${JSON.stringify(twin)} only in case`);
      continue;
    }
    origins.set(file.path, origin);
    lowercase.set(file.path.toLowerCase(), file.path);
  }
  for (const file of origins.keys()) {
    const segments = file.split("/");
    for (let end = 1; end < segments.length; end++) {
      const dir = segments.slice(0, end).join("/");
      if (origins.has(dir)) problems.push(`${platform}: path ${JSON.stringify(dir)} is a file, but ${JSON.stringify(file)} needs it as a directory`);
    }
  }
  if (problems.length > 0) throw new GeneratorError("unsafe or clashing output paths:", problems);

  const files = entries
    .filter(({ file }) => file.path !== FILES_LIST)
    .map(({ file }) => ({ path: file.path, content: normalizeContent(file.content) }));
  const paths = [...files.map((file) => file.path), FILES_LIST].sort(compareBytes);
  files.push({ path: FILES_LIST, content: `${paths.join("\n")}\n` });
  return files.sort((a, b) => compareBytes(a.path, b.path));
}

// ---------------------------------------------------------------------------------------------
// dist/

/** Files and links under `dir`, as relative POSIX paths; empty when `dir` does not exist. */
async function listFiles(dir: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(prefix === "" ? dir : path.join(dir, prefix), { withFileTypes: true }).catch(
    (error: unknown) => {
      if (errorCode(error) === "ENOENT") return undefined;
      throw error;
    },
  );
  if (entries === undefined) return [];
  const out: string[] = [];
  for (const entry of entries) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    // Links count as files and are never followed.
    if (entry.isDirectory()) out.push(...(await listFiles(dir, relative)));
    else out.push(relative);
  }
  return out;
}

/** Remove empty directories below `dir`, deepest first. True when `dir`/`prefix` ends up empty. */
async function removeEmptyDirs(dir: string, prefix = ""): Promise<boolean> {
  const entries = await readdir(prefix === "" ? dir : path.join(dir, prefix), { withFileTypes: true });
  let empty = true;
  for (const entry of entries) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory() && (await removeEmptyDirs(dir, relative))) await rmdir(path.join(dir, relative));
    else empty = false;
  }
  return empty;
}

/** The bytes of a regular file, or undefined when nothing regular is there. */
async function readRegular(target: string): Promise<Buffer | undefined> {
  try {
    const stats = await lstat(target);
    return stats.isFile() ? await readFile(target) : undefined;
  } catch (error) {
    if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") return undefined;
    throw error;
  }
}

async function writePlatform(dir: string, files: readonly OutputFile[]): Promise<{ written: string[]; removed: string[] }> {
  const wanted = new Set(files.map((file) => file.path));
  const removed: string[] = [];
  // Stale files go first, so a stale file or directory never blocks a path the build needs.
  for (const file of await listFiles(dir)) {
    if (wanted.has(file)) continue;
    await rm(path.join(dir, file), { force: true });
    removed.push(file);
  }
  await mkdir(dir, { recursive: true });
  await removeEmptyDirs(dir);

  const written: string[] = [];
  for (const file of files) {
    const target = path.join(dir, ...file.path.split("/"));
    const data = Buffer.from(file.content, "utf8");
    const current = await readRegular(target);
    if (current?.equals(data)) continue;
    // Replace a link or other non-regular entry instead of writing through it.
    if (current === undefined) await rm(target, { recursive: true, force: true });
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, data);
    written.push(file.path);
  }
  return { written, removed: removed.sort(compareBytes) };
}

async function comparePlatform(dir: string, label: string, files: readonly OutputFile[]): Promise<string[]> {
  const onDisk = new Set(await listFiles(dir));
  const missing: string[] = [];
  const changed: string[] = [];
  for (const file of files) {
    if (!onDisk.has(file.path)) {
      missing.push(`${label}: missing ${file.path}`);
      continue;
    }
    const current = await readRegular(path.join(dir, ...file.path.split("/")));
    if (current === undefined || !current.equals(Buffer.from(file.content, "utf8"))) changed.push(`${label}: changed ${file.path}`);
  }
  const wanted = new Set(files.map((file) => file.path));
  const extra = [...onDisk]
    .filter((file) => !wanted.has(file))
    .sort(compareBytes)
    .map((file) => `${label}: extra ${file}`);
  return [...missing, ...changed, ...extra];
}

// ---------------------------------------------------------------------------------------------

/** The size table as text lines: kind, id, approximate tokens, budget limit and name. */
export function sizeLines(rows: readonly SizeRow[]): string[] {
  const width = Math.max(2, ...rows.map((row) => row.id.length));
  const lines = [`${"kind".padEnd(8)} ${"id".padEnd(width)} ${"tokens".padStart(6)} ${"budget".padStart(6)}`];
  for (const row of rows) {
    const over = row.tokens > row.limit ? "  OVER" : "";
    lines.push(
      `${row.kind.padEnd(8)} ${row.id.padEnd(width)} ${String(row.tokens).padStart(6)} ${String(row.limit).padStart(6)} ${row.budget}${over}`,
    );
  }
  return lines;
}

export async function build(options: BuildOptions): Promise<BuildResult> {
  const log = options.log ?? ((line: string) => console.log(line));
  const platforms = Object.keys(options.emitters);
  const badNames = platforms.flatMap((platform) => {
    const reason = unsafePathReason(platform) ?? (platform.includes("/") ? "must be a single directory name" : undefined);
    return reason === undefined ? [] : [`platform ${JSON.stringify(platform)} ${reason}`];
  });
  if (badNames.length > 0) throw new GeneratorError("bad platform names:", badNames);

  const source = await load(options.root);
  const harness = resolveHarness(source);
  const sizes = sizeTable(source, harness);
  for (const line of sizeLines(sizes)) log(line);
  checkHarness(source, harness, sizes);

  const extras = options.extras === undefined ? [] : await options.extras(harness);
  if (!Array.isArray(extras)) throw new GeneratorError("extras must return a list of files");
  const support = supportFiles(harness);

  const outputs: { platform: string; files: OutputFile[] }[] = [];
  const problems: string[] = [];
  for (const [platform, emit] of Object.entries(options.emitters)) {
    const groups: FileGroup[] = [
      { origin: `emitter ${platform}`, files: emit(harness) },
      { origin: "extras", files: extras },
      { origin: "support files", files: support },
    ];
    try {
      outputs.push({ platform, files: platformFiles(platform, groups) });
    } catch (error) {
      if (!(error instanceof GeneratorError)) throw error;
      problems.push(...error.problems);
    }
  }
  if (problems.length > 0) throw new GeneratorError("unsafe or clashing output paths:", problems);

  const results: PlatformResult[] = [];
  if (options.check) {
    const differences: string[] = [];
    for (const { platform, files } of outputs) {
      differences.push(...(await comparePlatform(path.join(options.root, "dist", platform), `dist/${platform}`, files)));
    }
    if (differences.length > 0) throw new GeneratorError("dist/ is out of date; run `bun run build`:", differences);
    for (const { platform, files } of outputs) {
      results.push({ platform, files, written: [], removed: [] });
      log(`dist/${platform}: ${files.length} files, up to date`);
    }
  } else {
    for (const { platform, files } of outputs) {
      const { written, removed } = await writePlatform(path.join(options.root, "dist", platform), files);
      results.push({ platform, files, written, removed });
      log(`dist/${platform}: ${files.length} files (${written.length} written, ${removed.length} removed)`);
    }
  }
  return { harness, sizes, platforms: results };
}

// ---------------------------------------------------------------------------------------------
// Command line

const USAGE = "usage: bun tools/build.ts [--check]";

async function main(args: readonly string[]): Promise<number> {
  const unknown = args.filter((arg) => arg !== "--check");
  if (unknown.length > 0) {
    console.error(`${USAGE}\nunknown argument: ${unknown.join(" ")}`);
    return 1;
  }
  const check = args.includes("--check");
  const root = path.resolve(import.meta.dir, "..");
  try {
    const { pluginFiles } = await import("./bundle-plugin.ts");
    await build({
      root,
      emitters: { "opencode-v2": emitV2 },
      extras: (harness) => pluginFiles(root, harness),
      check,
    });
    return 0;
  } catch (error) {
    const detail = error instanceof GeneratorError ? error.message : error instanceof Error ? (error.stack ?? error.message) : String(error);
    console.error(`${check ? "build check" : "build"} failed: ${detail}`);
    return 1;
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
