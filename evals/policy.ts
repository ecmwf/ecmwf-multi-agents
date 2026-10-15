// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

// How the runner answers on the user's behalf: permission requests and questions.

import type { AnsweringPolicy, FormField, FormRequest, PermissionReply, PermissionRequest, PermissionRule, QuestionRequest } from "./types.ts";

/** Optional leading parts of a git command line: git, then global options such as -C DIR. */
const GIT = String.raw`\bgit(?:\s+(?:-C\s+\S+|-c\s+\S+|--[\w-]+(?:=\S+)?))*\s+`;

/** Approvals the runner always refuses: publishing, merging and rewriting history. */
export const REFUSED: PermissionRule[] = [
  { action: "shell", pattern: new RegExp(`${GIT}push\\b`), reply: "reject", reason: "push" },
  { action: "shell", pattern: /\bgh\s+pr\s+(?:create|merge|close)\b/, reply: "reject", reason: "pull request" },
  { action: "shell", pattern: /\bgh\s+(?:release|repo\s+delete)\b/, reply: "reject", reason: "publishing" },
  { action: "shell", pattern: new RegExp(`${GIT}merge\\b`), reply: "reject", reason: "merge" },
  { action: "shell", pattern: new RegExp(`${GIT}(?:rebase|filter-branch|filter-repo)\\b`), reply: "reject", reason: "history rewrite" },
  { action: "shell", pattern: new RegExp(`${GIT}commit\\b.*\\s--amend\\b`), reply: "reject", reason: "history rewrite" },
  { action: "shell", pattern: new RegExp(`${GIT}reset\\b.*\\s--hard\\b`), reply: "reject", reason: "history rewrite" },
  { action: "shell", pattern: new RegExp(`${GIT}branch\\b.*\\s-D\\b`), reply: "reject", reason: "history rewrite" },
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

/** The reply to a permission request: the first rule that matches any of its resources. */
export function decidePermission(policy: AnsweringPolicy, request: Pick<PermissionRequest, "action" | "resources">): { reply: PermissionReply; reason: string } {
  const resources = request.resources.length > 0 ? request.resources : [""];
  for (const rule of policy.permissions) {
    if (rule.action !== undefined && rule.action !== request.action) continue;
    if (resources.some((resource) => rule.pattern.test(resource))) return { reply: rule.reply, reason: rule.reason };
  }
  return { reply: policy.fallback, reason: "default" };
}

const NO_OPTION = "Use your best judgement and say what you assumed.";

/** Answers to a question request, one list of labels per question. */
export function answerQuestions(policy: AnsweringPolicy, request: Pick<QuestionRequest, "questions">): string[][] {
  switch (policy.questions) {
    case "first-option":
      return request.questions.map((question) => {
        const first = question.options[0]?.label;
        return [first ?? NO_OPTION];
      });
  }
}

/** The fields of a form that can be answered: every field except links to open. */
function answerable(form: Pick<FormRequest, "fields">): FormField[] {
  return form.fields.filter((field) => field.type !== "external");
}

/** A form's fields as questions, one per answerable field, in order. */
export function formQuestions(form: Pick<FormRequest, "fields">): QuestionRequest {
  return {
    questions: answerable(form).map((field) => ({
      question: field.description ?? field.title ?? field.key,
      ...(field.title ? { header: field.title } : {}),
      options: (field.options ?? []).map((option) => ({ label: option.label, ...(option.description ? { description: option.description } : {}) })),
      ...(field.type === "multiselect" ? { multiple: true } : {}),
    })),
  };
}

/**
 * The reply to a form, from the answers to its questions (formQuestions): the chosen option's
 * value, a list for a multiple choice, and a usable value for fields without options.
 */
export function formAnswer(form: Pick<FormRequest, "fields">, answers: string[][]): Record<string, string | number | boolean | string[]> {
  const answer: Record<string, string | number | boolean | string[]> = {};
  answerable(form).forEach((field, index) => {
    const labels = answers[index] ?? [];
    const values = labels.map((label) => field.options?.find((option) => option.label === label)?.value ?? label);
    switch (field.type) {
      case "multiselect":
        answer[field.key] = values;
        break;
      case "boolean":
        answer[field.key] = typeof field.default === "boolean" ? field.default : true;
        break;
      case "number":
      case "integer":
        answer[field.key] = typeof field.default === "number" ? field.default : (field.minimum ?? 0);
        break;
      default:
        answer[field.key] = values[0] ?? (typeof field.default === "string" ? field.default : NO_OPTION);
    }
  });
  return answer;
}
