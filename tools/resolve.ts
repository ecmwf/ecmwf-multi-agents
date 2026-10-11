// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

// Turns a validated Source into a ResolvedHarness: rule sets expanded, prompt files joined, the
// default profile baked in, with each profile effort written as opencode's model variant. Also
// holds the checks that run on the resolved text: prompt budgets and the review policy line of
// the default agent.

import { REVIEW_POLICIES } from "../plugin/types.ts";
import { MANIFEST_FILE, type PermissionEntry, type RuleSetItem, type Source, type SourceAgent } from "./load.ts";
import type {
  Profile,
  ProfileAgent,
  ResolvedAgent,
  ResolvedCommand,
  ResolvedHarness,
  ResolvedSkill,
  Rule,
} from "./types.ts";
import { formatKeyPath, GeneratorError, own, toLf } from "./util.ts";

/** The review policy the generator writes; the plugin rewrites the line from the settings. */
export const DEFAULT_REVIEW_POLICY = "auto";
const REVIEW_PREFIX = "Review policy: ";
const REVIEW_LINE = new RegExp(`^${REVIEW_PREFIX}(${REVIEW_POLICIES.join("|")})$`);
const REVIEW_LIKE = /review policy/i;

/** Characters (code points) of a text. */
function characters(text: string): number {
  let count = 0;
  for (const _ of text) count++;
  return count;
}

/** Approximate tokens of a text: characters / 4, rounded up. */
export function approxTokens(text: string): number {
  return Math.ceil(characters(text) / 4);
}

/** Expand `{use, effect}` entries into one rule per rule-set item, keeping the order. */
export function expandPermissions(
  entries: readonly PermissionEntry[],
  ruleSets: ReadonlyMap<string, readonly RuleSetItem[]>,
): Rule[] {
  const out: Rule[] = [];
  for (const entry of entries) {
    if ("use" in entry) {
      const items = ruleSets.get(entry.use);
      if (items === undefined) throw new GeneratorError(`unknown rule set ${JSON.stringify(entry.use)}`);
      for (const item of items) out.push({ action: item.action, resource: item.resource, effect: entry.effect });
    } else {
      out.push({ action: entry.action, resource: entry.resource, effect: entry.effect });
    }
  }
  return out;
}

/** A source Markdown file with LF line endings, trimmed. */
function sourceText(source: Source, file: string): string {
  const text = source.markdown.get(file);
  if (text === undefined) throw new GeneratorError(`src/${file} was not loaded`);
  return toLf(text).trim();
}

/** A profile with its agents in manifest order. */
function orderedProfile(profile: Profile, agents: readonly SourceAgent[]): Profile {
  const out: Record<string, ProfileAgent> = {};
  for (const agent of agents) {
    const choice = own(profile.agents, agent.id);
    if (choice === undefined) continue;
    const entry: ProfileAgent = {};
    if (choice.model !== undefined) entry.model = choice.model;
    if (choice.effort !== undefined) entry.effort = choice.effort;
    out[agent.id] = entry;
  }
  return { id: profile.id, description: profile.description, agents: out };
}

/** Resolve without running the checks. */
export function resolveHarness(source: Source): ResolvedHarness {
  const { manifest } = source;
  const profile = source.profiles.find((candidate) => candidate.id === manifest.defaultProfile);
  if (profile === undefined) throw new GeneratorError(`${MANIFEST_FILE}: defaultProfile: names no profile`);

  const agents = manifest.agents.map((agent): ResolvedAgent => {
    const resolved: ResolvedAgent = {
      id: agent.id,
      mode: agent.mode,
      description: agent.description,
      prompt: agent.prompt.map((file) => sourceText(source, file)).join("\n\n"),
      permissions: expandPermissions(agent.permissions, manifest.ruleSets),
    };
    if (agent.steps !== undefined) resolved.steps = agent.steps;
    if (agent.color !== undefined) resolved.color = agent.color;
    const choice = own(profile.agents, agent.id);
    if (choice?.model !== undefined) resolved.model = choice.model;
    // opencode calls the reasoning effort the model variant.
    if (choice?.effort !== undefined) resolved.variant = choice.effort;
    return resolved;
  });

  const commands = manifest.commands.map(
    (command): ResolvedCommand => ({
      id: command.id,
      description: command.description,
      agent: command.agent,
      subtask: command.subtask,
      template: sourceText(source, command.template),
    }),
  );
  const skills = manifest.skills.map(
    (skill): ResolvedSkill => ({
      id: skill.id,
      description: skill.description,
      body: sourceText(source, skill.body),
      hidden: skill.hidden,
    }),
  );

  return {
    name: manifest.name,
    version: source.version,
    defaultAgent: manifest.defaultAgent,
    defaultProfile: manifest.defaultProfile,
    workDir: manifest.workDir,
    marker: manifest.marker,
    agents,
    commands,
    skills,
    profiles: source.profiles.map((candidate) => orderedProfile(candidate, manifest.agents)),
  };
}

// ---------------------------------------------------------------------------------------------
// Budgets

export interface SizeRow {
  kind: "agent" | "command" | "skill";
  id: string;
  /** Manifest key path of the measured text, such as `agents.scout.prompt`. */
  key: string;
  /** Source files of the text, relative to the repository root. */
  files: string[];
  characters: number;
  /** Approximate tokens: characters / 4, rounded up. */
  tokens: number;
  /** Budget name. */
  budget: string;
  /** Budget limit in approximate tokens. */
  limit: number;
}

/** The size of every agent prompt, command template and skill body, with its budget. Never fails on size. */
export function sizeTable(source: Source, harness: ResolvedHarness): SizeRow[] {
  const { manifest } = source;
  const row = (kind: SizeRow["kind"], id: string, key: string, files: string[], text: string, budget: string): SizeRow => {
    const limit = manifest.budgets.get(budget);
    if (limit === undefined) throw new GeneratorError(`${MANIFEST_FILE}: budgets.${budget}: required key is missing`);
    return {
      kind,
      id,
      key,
      files: files.map((file) => `src/${file}`),
      characters: characters(text),
      tokens: approxTokens(text),
      budget,
      limit,
    };
  };
  const rows: SizeRow[] = [];
  for (const agent of manifest.agents) {
    const resolved = harness.agents.find((candidate) => candidate.id === agent.id);
    if (resolved === undefined) throw new GeneratorError(`agent ${agent.id} was not resolved`);
    const key = formatKeyPath(["agents", agent.id, "prompt"]);
    rows.push(row("agent", agent.id, key, agent.prompt, resolved.prompt, agent.budget));
  }
  for (const command of manifest.commands) {
    const resolved = harness.commands.find((candidate) => candidate.id === command.id);
    if (resolved === undefined) throw new GeneratorError(`command ${command.id} was not resolved`);
    const key = formatKeyPath(["commands", command.id, "template"]);
    rows.push(row("command", command.id, key, [command.template], resolved.template, "command"));
  }
  for (const skill of manifest.skills) {
    const resolved = harness.skills.find((candidate) => candidate.id === skill.id);
    if (resolved === undefined) throw new GeneratorError(`skill ${skill.id} was not resolved`);
    const key = formatKeyPath(["skills", skill.id, "body"]);
    rows.push(row("skill", skill.id, key, [skill.body], resolved.body, "skill"));
  }
  return rows;
}

/** One problem per row over its budget. */
export function budgetProblems(rows: readonly SizeRow[]): string[] {
  return rows
    .filter((row) => row.tokens > row.limit)
    .map(
      (row) =>
        `${row.files.join(", ")}: ${row.key}: about ${row.tokens} tokens (${row.characters} characters), ` +
        `over the ${row.budget} budget of ${row.limit} tokens by ${row.tokens - row.limit}`,
    );
}

/** Throws listing every item over its budget; returns the size table otherwise. */
export function checkBudgets(source: Source, harness: ResolvedHarness): SizeRow[] {
  const rows = sizeTable(source, harness);
  const problems = budgetProblems(rows);
  if (problems.length > 0) throw new GeneratorError("over budget:", problems);
  return rows;
}

// ---------------------------------------------------------------------------------------------
// Review policy line

/**
 * The default agent's prompt must hold exactly one line `Review policy: <policy>`, and the
 * generated value is `auto`. The plugin finds the line and rewrites it from the settings.
 */
export function reviewPolicyProblems(source: Source, harness: ResolvedHarness): string[] {
  const id = harness.defaultAgent;
  const agent = harness.agents.find((candidate) => candidate.id === id);
  const sourceAgent = source.manifest.agents.find((candidate) => candidate.id === id);
  if (agent === undefined || sourceAgent === undefined) return [`${MANIFEST_FILE}: defaultAgent: names no agent`];
  const files = sourceAgent.prompt.map((file) => `src/${file}`);
  const where = `${files.join(", ")}: ${formatKeyPath(["agents", id, "prompt"])}`;
  const expected = `"${REVIEW_PREFIX}${DEFAULT_REVIEW_POLICY}"`;
  const lines = agent.prompt.split("\n");
  const matches = lines.filter((line) => REVIEW_LINE.test(line));
  if (matches.length === 0) {
    const near = lines.find((line) => REVIEW_LIKE.test(line));
    const hint =
      near === undefined ? "" : `; ${JSON.stringify(near)} does not count: the line must be exactly "${REVIEW_PREFIX}<policy>"`;
    return [`${where}: has no line ${expected}${hint}`];
  }
  if (matches.length > 1) {
    return [`${where}: has ${matches.length} "${REVIEW_PREFIX}..." lines; it must have exactly one, which the plugin rewrites`];
  }
  const line = matches[0] ?? "";
  if (line !== `${REVIEW_PREFIX}${DEFAULT_REVIEW_POLICY}`) {
    return [`${where}: has ${JSON.stringify(line)}; the generated prompt must say ${expected}, the default policy`];
  }
  return [];
}

export function checkReviewPolicy(source: Source, harness: ResolvedHarness): void {
  const problems = reviewPolicyProblems(source, harness);
  if (problems.length > 0) throw new GeneratorError("review policy line:", problems);
}

// ---------------------------------------------------------------------------------------------

/** Run every check on a resolved harness; throws listing all problems together. */
export function checkHarness(source: Source, harness: ResolvedHarness, rows = sizeTable(source, harness)): void {
  const problems = [...budgetProblems(rows), ...reviewPolicyProblems(source, harness)];
  if (problems.length > 0) {
    throw new GeneratorError(`${problems.length} check${problems.length === 1 ? "" : "s"} failed:`, problems);
  }
}

/** Resolve and check. */
export function resolve(source: Source): ResolvedHarness {
  const harness = resolveHarness(source);
  checkHarness(source, harness);
  return harness;
}
