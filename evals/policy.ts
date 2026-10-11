// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

// How the runner answers on the user's behalf: permission requests and questions.

import type { AnsweringPolicy, PermissionReply, PermissionRequest, PermissionRule, QuestionRequest } from "./types.ts";

/** Optional leading parts of a git command line: git, then global options such as -C DIR. */
const GIT = String.raw`\bgit(?:\s+(?:-C\s+\S+|-c\s+\S+|--[\w-]+(?:=\S+)?))*\s+`;

/** Approvals the runner always refuses: publishing, merging and rewriting history. */
export const REFUSED: PermissionRule[] = [
  { permission: "bash", pattern: new RegExp(`${GIT}push\\b`), reply: "reject", reason: "push" },
  { permission: "bash", pattern: /\bgh\s+pr\s+(?:create|merge|close)\b/, reply: "reject", reason: "pull request" },
  { permission: "bash", pattern: /\bgh\s+(?:release|repo\s+delete)\b/, reply: "reject", reason: "publishing" },
  { permission: "bash", pattern: new RegExp(`${GIT}merge\\b`), reply: "reject", reason: "merge" },
  { permission: "bash", pattern: new RegExp(`${GIT}(?:rebase|filter-branch|filter-repo)\\b`), reply: "reject", reason: "history rewrite" },
  { permission: "bash", pattern: new RegExp(`${GIT}commit\\b.*\\s--amend\\b`), reply: "reject", reason: "history rewrite" },
  { permission: "bash", pattern: new RegExp(`${GIT}reset\\b.*\\s--hard\\b`), reply: "reject", reason: "history rewrite" },
  { permission: "bash", pattern: new RegExp(`${GIT}branch\\b.*\\s-D\\b`), reply: "reject", reason: "history rewrite" },
];

export const DEFAULT_POLICY: AnsweringPolicy = {
  permissions: REFUSED,
  fallback: "once",
  questions: "first-option",
};

/** The default policy with a case's changes; case rules come before the default ones. */
export function policyFor(changes: Partial<AnsweringPolicy> | undefined): AnsweringPolicy {
  if (!changes) return DEFAULT_POLICY;
  return {
    permissions: [...(changes.permissions ?? []), ...DEFAULT_POLICY.permissions],
    fallback: changes.fallback ?? DEFAULT_POLICY.fallback,
    questions: changes.questions ?? DEFAULT_POLICY.questions,
  };
}

/** The reply to a permission request: the first rule that matches any of its patterns. */
export function decidePermission(policy: AnsweringPolicy, request: Pick<PermissionRequest, "permission" | "patterns">): { reply: PermissionReply; reason: string } {
  const patterns = request.patterns.length > 0 ? request.patterns : [""];
  for (const rule of policy.permissions) {
    if (rule.permission !== undefined && rule.permission !== request.permission) continue;
    if (patterns.some((pattern) => rule.pattern.test(pattern))) return { reply: rule.reply, reason: rule.reason };
  }
  return { reply: policy.fallback, reason: "default" };
}

/** Answers to a question request, one list of labels per question. */
export function answerQuestions(policy: AnsweringPolicy, request: Pick<QuestionRequest, "questions">): string[][] {
  switch (policy.questions) {
    case "first-option":
      return request.questions.map((question) => {
        const first = question.options[0]?.label;
        return [first ?? "Use your best judgement and say what you assumed."];
      });
  }
}
