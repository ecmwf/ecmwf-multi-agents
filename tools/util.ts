// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

// Helpers shared by the generator modules: one error type that lists every problem, key path
// formatting, text normalisation and the rules for safe relative paths.

/** A failure that lists every problem found. Each problem names its file and key path. */
export class GeneratorError extends Error {
  readonly problems: readonly string[];

  constructor(summary: string, problems: readonly string[] = []) {
    super(problems.length === 0 ? summary : `${summary}\n${problems.map((problem) => `  ${problem}`).join("\n")}`);
    this.name = "GeneratorError";
    this.problems = [...problems];
  }
}

export type KeyPath = readonly (string | number)[];

const SIMPLE_KEY = /^[A-Za-z0-9_$-]+$/;

/** A key path as text, such as `agents.scout.permissions[2].action`. */
export function formatKeyPath(at: KeyPath): string {
  let out = "";
  for (const part of at) {
    if (typeof part === "number") out += `[${part}]`;
    else if (SIMPLE_KEY.test(part)) out += out === "" ? part : `.${part}`;
    else out += `[${JSON.stringify(part)}]`;
  }
  return out === "" ? "(top level)" : out;
}

/** The value of an own property, ignoring anything inherited from Object.prototype. */
export function own<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/** Normalise line endings to LF. */
export function toLf(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/** LF line endings and exactly one trailing newline. */
export function normalizeContent(text: string): string {
  return `${toLf(text).replace(/\n+$/, "")}\n`;
}

/** Order strings by their UTF-8 bytes, as `LC_ALL=C sort` does. */
export function compareBytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

/**
 * Why `p` is not a safe relative POSIX path, or undefined when it is. A safe path is
 * normalised, separates segments with "/", never leaves its base directory, and uses only
 * letters, digits, ".", "_" and "-" (no leading "." or "-"), so a POSIX shell script can read
 * it from a list with one path per line.
 */
export function unsafePathReason(p: string): string | undefined {
  if (p === "") return "is empty";
  if (p.includes("\\")) return 'uses "\\"; separate segments with "/"';
  if (p.startsWith("/")) return "is absolute";
  const segments = p.split("/");
  if (segments.includes("..")) return 'has a ".." segment';
  if (segments.includes(".")) return 'has a "." segment';
  if (segments.includes("")) return "has an empty segment";
  for (const segment of segments) {
    if (!SEGMENT.test(segment)) {
      return `has the segment ${JSON.stringify(segment)}; use letters, digits, ".", "_" and "-", not starting with "." or "-"`;
    }
  }
  return undefined;
}

/** The `code` of a Node.js system error, such as "ENOENT". */
export function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

/** "a, b or c" */
export function listWords(words: readonly string[], last = "or"): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} ${last} ${words.at(-1)}`;
}
