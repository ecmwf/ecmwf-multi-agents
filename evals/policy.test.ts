// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { answerQuestions, DEFAULT_POLICY, decidePermission, formAnswer, formQuestions, policyFor } from "./policy.ts";
import type { FormRequest } from "./types.ts";

const shell = (command: string) => decidePermission(DEFAULT_POLICY, { action: "shell", resources: [command] });

describe("permission replies", () => {
  test.each([
    ["git push origin main", "push"],
    ["git push", "push"],
    ["git -C /tmp/project push origin main", "push"],
    ["cd sub && git push --force origin HEAD", "push"],
    ["git -c core.sshCommand=ssh push", "push"],
    ["gh pr create --fill", "pull request"],
    ["gh pr merge 12 --squash", "pull request"],
    ["gh pr close 12", "pull request"],
    ["gh release create v1", "publishing"],
    ["git merge feature", "merge"],
    ["git rebase -i HEAD~3", "history rewrite"],
    ["git commit --amend --no-edit", "history rewrite"],
    ["git reset --hard HEAD~1", "history rewrite"],
    ["git branch -D old", "history rewrite"],
  ])("refuses %s", (command, reason) => {
    expect(shell(command)).toEqual({ reply: "reject", reason });
  });

  test.each(["git status", "git commit -m 'push the fix later'", "git log --grep=push", "python3 -m unittest", "git stash", "git restore README.md"])("approves %s once", (command) => {
    expect(shell(command)).toEqual({ reply: "once", reason: "default" });
  });

  test("rules for another action do not apply", () => {
    expect(decidePermission(DEFAULT_POLICY, { action: "edit", resources: ["git push notes.md"] })).toEqual({ reply: "once", reason: "default" });
    expect(decidePermission(DEFAULT_POLICY, { action: "external_directory", resources: [] })).toEqual({ reply: "once", reason: "default" });
  });

  test("any resource of a request can match", () => {
    expect(decidePermission(DEFAULT_POLICY, { action: "shell", resources: ["git add README.md", "git push origin main"] }).reply).toBe("reject");
  });

  test("case rules come first and the fallback can change", () => {
    const policy = policyFor({ permissions: [{ action: "shell", pattern: /^git push/, reply: "once", reason: "allowed here" }], fallback: "reject" });
    expect(decidePermission(policy, { action: "shell", resources: ["git push origin main"] })).toEqual({ reply: "once", reason: "allowed here" });
    expect(decidePermission(policy, { action: "shell", resources: ["git merge x"] }).reply).toBe("reject");
    expect(decidePermission(policy, { action: "edit", resources: ["a.py"] })).toEqual({ reply: "reject", reason: "default" });
    expect(policyFor(undefined)).toBe(DEFAULT_POLICY);
  });
});

describe("question answers", () => {
  test("the first option of each question", () => {
    const answers = answerQuestions(DEFAULT_POLICY, {
      questions: [
        { question: "Which format?", header: "Format", options: [{ label: "Table (Recommended)" }, { label: "JSON" }] },
        { question: "Scope?", header: "Scope", options: [{ label: "Only summary" }, { label: "Everything" }], multiple: true },
      ],
    });
    expect(answers).toEqual([["Table (Recommended)"], ["Only summary"]]);
  });

  test("a question without options gets a short free answer", () => {
    expect(answerQuestions(DEFAULT_POLICY, { questions: [{ question: "Anything else?", options: [] }] })).toEqual([["Use your best judgement and say what you assumed."]]);
  });
});

describe("forms", () => {
  const form: FormRequest = {
    id: "frm_1",
    sessionID: "ses_1",
    title: "Questions",
    metadata: { kind: "question" },
    fields: [
      { key: "q0", type: "string", title: "Detail", description: "How detailed?", options: [{ value: "brief", label: "Brief", description: "short" }, { value: "long", label: "Long" }] },
      { key: "q1", type: "multiselect", title: "Scope", description: "Which parts?", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] },
      { key: "q2", type: "string", description: "Anything else?" },
      { key: "q3", type: "boolean", title: "Sure?" },
      { key: "link", type: "external", title: "Open this" },
    ],
  };

  test("a form's fields become questions, links to open left out", () => {
    expect(formQuestions(form)).toEqual({
      questions: [
        { question: "How detailed?", header: "Detail", options: [{ label: "Brief", description: "short" }, { label: "Long" }] },
        { question: "Which parts?", header: "Scope", options: [{ label: "A" }, { label: "B" }], multiple: true },
        { question: "Anything else?", options: [] },
        { question: "Sure?", header: "Sure?", options: [] },
      ],
    });
  });

  test("the policy's answers become the form's reply: option values, a list for multiple choice", () => {
    const answers = answerQuestions(DEFAULT_POLICY, formQuestions(form));
    expect(answers).toEqual([["Brief"], ["A"], ["Use your best judgement and say what you assumed."], ["Use your best judgement and say what you assumed."]]);
    expect(formAnswer(form, answers)).toEqual({ q0: "brief", q1: ["a"], q2: "Use your best judgement and say what you assumed.", q3: true });
  });
});
