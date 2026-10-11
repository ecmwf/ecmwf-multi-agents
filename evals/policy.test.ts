// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { answerQuestions, DEFAULT_POLICY, decidePermission, policyFor } from "./policy.ts";

const bash = (command: string) => decidePermission(DEFAULT_POLICY, { permission: "bash", patterns: [command] });

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
    expect(bash(command)).toEqual({ reply: "reject", reason });
  });

  test.each(["git status", "git commit -m 'push the fix later'", "git log --grep=push", "python3 -m unittest", "git stash", "git restore README.md"])("approves %s once", (command) => {
    expect(bash(command)).toEqual({ reply: "once", reason: "default" });
  });

  test("rules for another permission do not apply", () => {
    expect(decidePermission(DEFAULT_POLICY, { permission: "edit", patterns: ["git push notes.md"] })).toEqual({ reply: "once", reason: "default" });
    expect(decidePermission(DEFAULT_POLICY, { permission: "external_directory", patterns: [] })).toEqual({ reply: "once", reason: "default" });
  });

  test("any pattern of a request can match", () => {
    expect(decidePermission(DEFAULT_POLICY, { permission: "bash", patterns: ["git add README.md", "git push origin main"] }).reply).toBe("reject");
  });

  test("case rules come first and the fallback can change", () => {
    const policy = policyFor({ permissions: [{ permission: "bash", pattern: /^git push/, reply: "once", reason: "allowed here" }], fallback: "reject" });
    expect(decidePermission(policy, { permission: "bash", patterns: ["git push origin main"] })).toEqual({ reply: "once", reason: "allowed here" });
    expect(decidePermission(policy, { permission: "bash", patterns: ["git merge x"] }).reply).toBe("reject");
    expect(decidePermission(policy, { permission: "edit", patterns: ["a.py"] })).toEqual({ reply: "reject", reason: "default" });
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
