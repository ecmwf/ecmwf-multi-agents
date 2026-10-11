// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

// Shell guard for opencode 1.x. There an "Allow always" answer lasts until opencode restarts,
// applies to every agent and is checked after the agent's own rules, so it overrides a helper's
// deny rules (docs/research/opencode-v1.md, "Other findings"). The guard checks a helper's shell
// commands against that helper's own rules again, with opencode's matching, and blocks what
// they deny. Like opencode's permissions it matches command text, so it is a guard rail, not a
// sandbox: `sh -c "..."`, `xargs`, aliases and scripts get past it.

import type { EmbeddedHarness, EmbeddedRule } from "./types.ts";

/**
 * opencode's wildcard match (packages/core/src/util/wildcard.ts at v1.18.35): `*` matches any
 * text including "/" and spaces, `?` one character, a pattern ending in " *" also matches the
 * text without that tail, backslashes count as "/", and Windows ignores case.
 */
export function wildcardMatch(input: string, pattern: string, platform: string = process.platform): boolean {
  const normalized = input.replaceAll("\\", "/");
  let escaped = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  if (escaped.endsWith(" .*")) escaped = `${escaped.slice(0, -3)}( .*)?`;
  return new RegExp(`^${escaped}$`, platform === "win32" ? "si" : "s").test(normalized);
}

/** The effect of the last rule that matches, or undefined when none does. */
export function evaluateRules(rules: readonly EmbeddedRule[], command: string, platform?: string): EmbeddedRule["effect"] | undefined {
  for (let i = rules.length - 1; i >= 0; i--) {
    const rule = rules[i]!;
    if (wildcardMatch(command, rule.resource, platform)) return rule.effect;
  }
  return undefined;
}

// Words that open or close a compound command; they are not commands themselves.
const KEYWORDS = new Set(["!", "{", "}", "if", "then", "else", "elif", "fi", "do", "done", "while", "until", "time", "esac"]);
// Commands opencode leaves out of its permission patterns (opencode/src/tool/shell.ts, CWD).
const DIRECTORY_COMMANDS = new Set(["cd", "chdir", "popd", "pushd", "push-location", "set-location"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/;

/**
 * Split a command line into the simple commands opencode checks one by one: at `&&`, `||`, `;`,
 * `|`, `|&`, `&` and line breaks outside quotes, plus the commands inside `$(...)`, backticks,
 * `<(...)` and `(...)` subshells. Quoted text, comments and here-document bodies stay whole.
 * Keywords such as `then` or `do` are dropped, as are test brackets, loop headers and lines that
 * only assign variables. The result approximates opencode's tree-sitter parse.
 */
export function commandParts(command: string): string[] {
  const raw: string[] = [];
  scanList(command, 0, null, raw);
  const out: string[] = [];
  for (const part of raw) {
    const cleaned = cleanPart(part);
    if (cleaned !== undefined) out.push(cleaned);
  }
  return out;
}

/** Scan from `start` until `close` (or the end); pushes finished parts. Returns the index after `close`. */
function scanList(src: string, start: number, close: ")" | "`" | null, out: string[]): number {
  let i = start;
  let part = "";
  const heredocs: Array<{ word: string; tabs: boolean }> = [];
  const flush = () => {
    if (part.trim() !== "") out.push(part.trim());
    part = "";
  };
  const atWordStart = () => part === "" || /\s$/.test(part);
  // True while the current part holds nothing but keywords, so a command could start here.
  const atCommandStart = () => part.trim().split(/\s+/).every((word) => word === "" || KEYWORDS.has(word));

  while (i < src.length) {
    const c = src[i]!;
    const next = src[i + 1];
    if (close !== null && c === close) {
      flush();
      return i + 1;
    }
    if (c === "\\") {
      if (next === "\n") part += " ";
      else part += src.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (c === "'") {
      const end = src.indexOf("'", i + 1);
      const stop = end === -1 ? src.length : end + 1;
      part += src.slice(i, stop);
      i = stop;
      continue;
    }
    if (c === '"') {
      const stop = scanDoubleQuoted(src, i, out);
      part += src.slice(i, stop);
      i = stop;
      continue;
    }
    if (c === "`") {
      const stop = scanList(src, i + 1, "`", out);
      part += src.slice(i, stop);
      i = stop;
      continue;
    }
    if (c === "$" && next === "(") {
      const stop = src[i + 2] === "(" ? skipArithmetic(src, i + 1) : scanList(src, i + 2, ")", out);
      part += src.slice(i, stop);
      i = stop;
      continue;
    }
    if (c === "$" && next === "{") {
      const stop = skipBraces(src, i + 1);
      part += src.slice(i, stop);
      i = stop;
      continue;
    }
    if ((c === "<" || c === ">") && next === "(") {
      const stop = scanList(src, i + 2, ")", out);
      part += src.slice(i, stop);
      i = stop;
      continue;
    }
    if (c === "<" && next === "<" && src[i + 2] === "<") {
      part += "<<<"; // a here-string: the next word is data
      i += 3;
      continue;
    }
    if (c === "<" && next === "<") {
      const heredoc = /^<<(-?)[ \t]*(?:'([^'\n]*)'|"([^"\n]*)"|([^\s;&|<>()]+))/.exec(src.slice(i));
      if (heredoc) {
        heredocs.push({ word: (heredoc[2] ?? heredoc[3] ?? heredoc[4] ?? "").replaceAll("\\", ""), tabs: heredoc[1] === "-" });
        part += heredoc[0];
        i += heredoc[0].length;
        continue;
      }
    }
    if (c === "#" && atWordStart()) {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "(" && atCommandStart()) {
      // A subshell, or an arithmetic command when doubled: either way not a command itself.
      i = next === "(" ? skipArithmetic(src, i) : scanList(src, i + 1, ")", out);
      continue;
    }
    if (c === "[" && next === "[" && atCommandStart()) {
      // A [[ test ]] may hold && and ||; keep it whole (it is not a command to opencode).
      const end = src.indexOf("]]", i + 2);
      const stop = end === -1 ? src.length : end + 2;
      part += src.slice(i, stop);
      i = stop;
      continue;
    }
    if (c === "\n") {
      flush();
      i++;
      for (const heredoc of heredocs.splice(0)) i = skipHeredoc(src, i, heredoc);
      continue;
    }
    if (c === ";") {
      flush();
      i += next === ";" ? 2 : 1;
      continue;
    }
    if (c === "|") {
      if (/[<>]$/.test(part)) {
        part += c; // the >| redirection
        i++;
        continue;
      }
      flush();
      i += next === "|" || next === "&" ? 2 : 1;
      continue;
    }
    if (c === "&") {
      if (next === "&") {
        flush();
        i += 2;
        continue;
      }
      if (next === ">" || /[<>]$/.test(part)) {
        part += c; // &> and >& redirections, as in 2>&1
        i++;
        continue;
      }
      flush(); // a background job
      i++;
      continue;
    }
    part += c;
    i++;
  }
  flush();
  return i;
}

/** Scan "..." from its opening quote; commands inside `$(...)` and backticks are collected. */
function scanDoubleQuoted(src: string, start: number, out: string[]): number {
  let i = start + 1;
  while (i < src.length) {
    const c = src[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === '"') return i + 1;
    if (c === "`") {
      i = scanList(src, i + 1, "`", out);
      continue;
    }
    if (c === "$" && src[i + 1] === "(") {
      i = src[i + 2] === "(" ? skipArithmetic(src, i + 1) : scanList(src, i + 2, ")", out);
      continue;
    }
    i++;
  }
  return i;
}

/** Skip `((...))` from its first "(", counting nested parentheses. */
function skipArithmetic(src: string, start: number): number {
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")" && --depth === 0) return i + 1;
  }
  return src.length;
}

/** Skip `{...}` from its "{", counting nested braces. */
function skipBraces(src: string, start: number): number {
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return i + 1;
  }
  return src.length;
}

/** Skip a here-document body that starts at `start`, through its closing word line. */
function skipHeredoc(src: string, start: number, heredoc: { word: string; tabs: boolean }): number {
  let i = start;
  while (i < src.length) {
    const end = src.indexOf("\n", i);
    const stop = end === -1 ? src.length : end;
    let line = src.slice(i, stop);
    if (heredoc.tabs) line = line.replace(/^\t+/, "");
    i = end === -1 ? src.length : end + 1;
    if (line === heredoc.word) break;
  }
  return i;
}

/** Drop keywords and things that are not commands; undefined when nothing is left. */
function cleanPart(part: string): string | undefined {
  let text = part.trim();
  while (true) {
    const word = /^(\S+)(\s+|$)/.exec(text);
    if (!word || !KEYWORDS.has(word[1]!)) break;
    text = text.slice(word[0].length);
  }
  // A function definition such as `name() {` or `function name {` opens a body.
  text = text.replace(/^(function\s+)?[A-Za-z_][\w.-]*\s*\(\s*\)\s*\{?\s*/, "").replace(/^function\s+[A-Za-z_][\w.-]*\s*\{?\s*/, "");
  if (text === "" || text === "{") return undefined;
  // Test brackets, loop and case headers, and leftover redirections are not commands to opencode.
  if (/^(\[\[?|for|select|case)(\s|$)/.test(text)) return undefined;
  if (/^(\d*[<>]|&>)/.test(text)) return undefined;
  if (withoutAssignments(text) === "") return undefined;
  return text;
}

// Commands that run the rest of the line as another command, written without options.
const WRAPPERS = new Set(["env", "command", "builtin", "exec", "nohup", "sudo"]);

/**
 * The texts a simple command is checked as: what opencode sees, then the same without leading
 * variable assignments and plain wrappers, then with git's global options (`-C dir`, `-c k=v`,
 * `--no-pager` and the like) removed. Later forms only add denials, never remove them.
 */
export function commandForms(part: string): string[] {
  const forms = [part];
  const add = (text: string) => {
    if (text !== "" && !forms.includes(text)) forms.push(text);
  };
  let text = withoutAssignments(part);
  add(text);
  while (WRAPPERS.has(firstWord(text))) text = withoutAssignments(text.slice(firstWord(text).length).trimStart());
  add(text);
  const words = text.split(/\s+/);
  if (words[0] === "git") {
    let i = 1;
    while (i < words.length && words[i]!.startsWith("-")) i += words[i] === "-C" || words[i] === "-c" ? 2 : 1;
    add(["git", ...words.slice(i)].join(" "));
  }
  return forms;
}

/** The command without leading `NAME=value` assignments, which only set its environment. */
export function withoutAssignments(part: string): string {
  let text = part;
  while (ASSIGNMENT.test(text)) {
    let i = text.indexOf("=") + 1;
    while (i < text.length && !/\s/.test(text[i]!)) {
      const c = text[i];
      if (c === "'" || c === '"') {
        const end = text.indexOf(c, i + 1);
        i = end === -1 ? text.length : end + 1;
      } else if (c === "\\") {
        i += 2;
      } else if (c === "$" && text[i + 1] === "(") {
        i = skipArithmetic(text, i + 1);
      } else {
        i++;
      }
    }
    text = text.slice(i).trimStart();
  }
  return text;
}

function firstWord(text: string): string {
  return /^\S*/.exec(text)?.[0] ?? "";
}

export interface GuardBlock {
  /** The simple command that a rule denies. */
  part: string;
  message: string;
}

/**
 * Check one shell command for an agent. Only the harness's helpers (subagents) are checked;
 * `lead` and agents outside the harness are left to opencode. Each simple command is checked in
 * every form `commandForms` gives, so `GIT_DIR=x git push` and `git -C repo push` count as
 * pushes. Returns a block when any form is denied.
 */
export function checkShellCommand(harness: EmbeddedHarness, agentId: string | undefined, command: string, platform?: string): GuardBlock | undefined {
  const agent = harness.agents.find((item) => item.id === agentId);
  if (agent === undefined || agent.mode !== "subagent" || agent.shell.length === 0) return undefined;
  for (const part of commandParts(command)) {
    const forms = commandForms(part);
    if (DIRECTORY_COMMANDS.has(firstWord(forms.at(-1) ?? part))) continue;
    const denied = forms.find((form) => evaluateRules(agent.shell, form, platform) === "deny");
    if (denied !== undefined) return { part, message: blockMessage(harness, agent.id, part, denied) };
  }
  return undefined;
}

function blockMessage(harness: EmbeddedHarness, agent: string, part: string, denied: string): string {
  const shown = JSON.stringify(part.length > 120 ? `${part.slice(0, 117)}...` : part);
  const owner = /^(git|gh)(\s|$)/.test(denied)
    ? `helpers may not run ${shown}; ${harness.defaultAgent} handles git and GitHub`
    : `${agent} may not run ${shown}; its permission rules deny it`;
  return `${harness.name}: ${owner}. Do not try another way: say in your report what is needed.`;
}
