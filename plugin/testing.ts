// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

// Test fixtures shared by the plugin and bundler tests. The harness mirrors src/manifest.jsonc and
// src/profiles/ by hand (rule sets expanded), so these tests do not depend on the generator core.

import { embedHarness } from "../tools/bundle-plugin.ts";
import type { ResolvedAgent, ResolvedHarness, Rule } from "../tools/types.ts";
import type { EmbeddedHarness, Environment } from "./types.ts";

const shell = (effect: Rule["effect"], ...resources: string[]): Rule[] =>
  resources.map((resource) => ({ action: "shell", resource, effect }));

const approvalNeeded = shell(
  "ask",
  "git push *",
  "git commit --amend *",
  "git reset --hard *",
  "git clean *",
  "git rebase *",
  "git branch -D *",
  "git restore *",
  "git checkout -- *",
  "git stash drop *",
  "git stash clear *",
  "gh pr create *",
  "gh pr merge *",
  "gh pr close *",
  "gh release *",
  "gh repo delete *",
);

const gitWrites = shell(
  "deny",
  ...[
    "add",
    "commit",
    "push",
    "pull",
    "fetch",
    "reset",
    "rebase",
    "merge",
    "cherry-pick",
    "revert",
    "am",
    "checkout",
    "switch",
    "restore",
    "stash",
    "clean",
    "rm",
    "mv",
    "tag",
    "branch",
    "remote",
    "worktree",
    "update-ref",
    "config",
  ].map((command) => `git ${command} *`),
);

const harnessTools: Rule[] = ["helpers_status", "helpers_steer", "helpers_cancel"].map((resource) => ({ action: "tool", resource, effect: "deny" }));

const readOnlyShell = shell(
  "allow",
  "git log *",
  "git show *",
  "git diff *",
  "git blame *",
  "git status *",
  "git grep *",
  "git ls-files *",
  "git rev-parse *",
  "ls *",
  "wc *",
  "file *",
  "tree *",
);

export const LEAD_PROMPT = "You are lead, the coordinating agent.\n\n## Review\n\nReview policy: auto\n\nThe line above sets when the reviewer checks work.";

const agents: ResolvedAgent[] = [
  {
    id: "lead",
    mode: "primary",
    description: "Talks to you, plans, hands work to helpers and checks the results. Start here.",
    prompt: LEAD_PROMPT,
    color: "#0b5394",
    model: "anthropic/claude-opus-5-5",
    variant: "xhigh",
    permissions: [
      { action: "question", resource: "*", effect: "allow" },
      { action: "delegate", resource: "*", effect: "deny" },
      ...["scout", "builder", "reviewer"].map((resource): Rule => ({ action: "delegate", resource, effect: "allow" })),
      ...approvalNeeded,
    ],
  },
  {
    id: "scout",
    mode: "subagent",
    description: "Read-only lookups and investigations in code, docs or the web.",
    prompt: "You are scout.",
    steps: 30,
    model: "anthropic/claude-sonnet-5-5",
    variant: "medium",
    permissions: [
      { action: "edit", resource: "*", effect: "deny" },
      { action: "edit", resource: ".ecmwf-multi-agents/notes/*", effect: "allow" },
      { action: "edit", resource: "*/.ecmwf-multi-agents/notes/*", effect: "allow" },
      { action: "shell", resource: "*", effect: "deny" },
      ...readOnlyShell,
      { action: "delegate", resource: "*", effect: "deny" },
      { action: "question", resource: "*", effect: "deny" },
      { action: "execute", resource: "*", effect: "deny" },
      { action: "skill", resource: "ecmwf-multi-agents-*", effect: "deny" },
      ...harnessTools,
    ],
  },
  {
    id: "builder",
    mode: "subagent",
    description: "Makes one clearly specified change, runs its checks and reports.",
    prompt: "You are builder.",
    steps: 60,
    model: "anthropic/claude-sonnet-5-5",
    variant: "high",
    permissions: [
      ...gitWrites,
      { action: "shell", resource: "gh *", effect: "deny" },
      { action: "delegate", resource: "*", effect: "deny" },
      { action: "question", resource: "*", effect: "deny" },
      { action: "skill", resource: "ecmwf-multi-agents-*", effect: "deny" },
      ...harnessTools,
    ],
  },
  {
    id: "reviewer",
    mode: "subagent",
    description: "Independent review of a plan or a change.",
    prompt: "You are reviewer.",
    steps: 30,
    model: "github-copilot/gpt-6.1-sol",
    variant: "medium",
    permissions: [
      { action: "edit", resource: "*", effect: "deny" },
      ...gitWrites,
      { action: "shell", resource: "gh *", effect: "deny" },
      ...shell("allow", "gh pr view *", "gh pr diff *", "gh pr checks *"),
      { action: "delegate", resource: "*", effect: "deny" },
      { action: "question", resource: "*", effect: "deny" },
      { action: "execute", resource: "*", effect: "deny" },
      { action: "skill", resource: "ecmwf-multi-agents-*", effect: "deny" },
      ...harnessTools,
    ],
  },
];

const anthropic = {
  lead: { model: "anthropic/claude-opus-5-5", effort: "xhigh" },
  scout: { model: "anthropic/claude-sonnet-5-5", effort: "medium" },
  builder: { model: "anthropic/claude-sonnet-5-5", effort: "high" },
};

/** A fresh copy of the fixture harness (tests may change it). */
export function resolvedFixture(): ResolvedHarness {
  return structuredClone({
    name: "ecmwf-multi-agents",
    version: "0.1.0",
    defaultAgent: "lead",
    defaultProfile: "default",
    workDir: ".ecmwf-multi-agents",
    marker: "# managed by ecmwf-multi-agents",
    agents,
    commands: [
      { id: "plan", description: "Plan a piece of work with you", agent: "lead", subtask: false, template: "Plan: $ARGUMENTS" },
      { id: "review", description: "Independent review of your changes", agent: "reviewer", subtask: false, template: "Review $ARGUMENTS" },
    ],
    skills: [{ id: "ecmwf-multi-agents-plan", description: "Plan file format and rules.", body: "# Plan\n\nRules.", hidden: true }],
    profiles: [
      { id: "anthropic", description: "Anthropic models only.", agents: { ...anthropic, reviewer: { model: "anthropic/claude-opus-5-5", effort: "high" } } },
      {
        id: "copilot",
        description: "GitHub Copilot models only.",
        agents: {
          lead: { model: "github-copilot/claude-opus-5.5", effort: "xhigh" },
          scout: { model: "github-copilot/claude-sonnet-5.5", effort: "medium" },
          builder: { model: "github-copilot/claude-sonnet-5.5", effort: "high" },
          reviewer: { model: "github-copilot/gpt-6.1-sol", effort: "medium" },
        },
      },
      { id: "default", description: "Anthropic, with GPT for the reviewer.", agents: { ...anthropic, reviewer: { model: "github-copilot/gpt-6.1-sol", effort: "medium" } } },
      { id: "inherit", description: "Every agent uses the session model.", agents: {} },
    ],
  } satisfies ResolvedHarness);
}

export function embeddedFixture(): EmbeddedHarness {
  return embedHarness(resolvedFixture());
}

/** An environment with the given files and variables, and nothing else. */
export function fakeEnvironment(files: Record<string, string>, env: Record<string, string | undefined> = {}, home = "/home/user"): Environment {
  return {
    env,
    home,
    readFile: (file) => files[file],
  };
}
