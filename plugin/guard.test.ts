// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { checkShellCommand, commandForms, commandParts, evaluateRules, wildcardMatch, withoutAssignments } from "./guard.ts";
import { embeddedFixture } from "./testing.ts";

const harness = embeddedFixture();
const blocked = (agent: string | undefined, command: string) => checkShellCommand(harness, agent, command, "linux")?.part;

describe("wildcardMatch (opencode's semantics)", () => {
  test.each([
    ["git push", "git push *", true],
    ["git push origin main", "git push *", true],
    ["git pushx", "git push *", false],
    ["git -C repo push", "git push *", false],
    ["git  push", "git push *", false],
    ["anything at all / with slashes", "*", true],
    ["", "*", true],
    [".ecmwf-multi-agents/notes/sub/a.md", ".ecmwf-multi-agents/notes/*", true],
    ["../.ecmwf-multi-agents/notes/a.md", ".ecmwf-multi-agents/notes/*", false],
    ["gh pr view 12", "gh pr view *", true],
    ["gh", "gh *", true],
    ["ghx", "gh *", false],
    ["git log", "git log", true],
    ["git log -1", "git log", false],
    ["git log\nmore", "git log *", false],
    ["git log -1\nmore", "git log *", true],
    ["a.b", "a?b", true],
    ["a.b", "a.b", true],
    ["axb", "a.b", false],
    ["(x)+[y]", "(x)+[y]", true],
    ["C:\\repo", "C:/repo", true],
  ] as const)("%j against %j is %p", (input, pattern, expected) => {
    expect(wildcardMatch(input, pattern, "linux")).toBe(expected);
  });

  test("ignores case on Windows only", () => {
    expect(wildcardMatch("GIT PUSH", "git push *", "win32")).toBe(true);
    expect(wildcardMatch("GIT PUSH", "git push *", "linux")).toBe(false);
  });
});

test("evaluateRules: the last matching rule wins; no match gives no decision", () => {
  const rules = [
    { resource: "*", effect: "deny" as const },
    { resource: "ls *", effect: "allow" as const },
    { resource: "ls secret*", effect: "ask" as const },
  ];
  expect(evaluateRules(rules, "ls -la")).toBe("allow");
  expect(evaluateRules(rules, "ls secret.txt")).toBe("ask");
  expect(evaluateRules(rules, "rm x")).toBe("deny");
  expect(evaluateRules([], "rm x")).toBeUndefined();
});

describe("commandParts", () => {
  test.each([
    ["git status", ["git status"]],
    ["  git status  ", ["git status"]],
    ["cd sub && git push", ["cd sub", "git push"]],
    ["make || git push origin main", ["make", "git push origin main"]],
    ["a; b;c", ["a", "b", "c"]],
    ["git log | head -5", ["git log", "head -5"]],
    ["make |& tee log", ["make", "tee log"]],
    ["sleep 1 & git push", ["sleep 1", "git push"]],
    ["make\ngit push\n", ["make", "git push"]],
    ["make 2>&1 | tee log", ["make 2>&1", "tee log"]],
    ["make &> log && ls", ["make &> log", "ls"]],
    ["make >| log", ["make >| log"]],
    ["ls > out.txt", ["ls > out.txt"]],
  ] as const)("splits %j", (command, parts) => {
    expect(commandParts(command)).toEqual([...parts]);
  });

  test.each([
    [`git commit -m "fix a; then b && c | d"`, [`git commit -m "fix a; then b && c | d"`]],
    [`echo 'git push; rm -rf /'`, [`echo 'git push; rm -rf /'`]],
    [`echo "a \\" ; still quoted"`, [`echo "a \\" ; still quoted"`]],
    [`echo a\\;b`, [`echo a\\;b`]],
    [`grep -n "x|y" file.txt`, [`grep -n "x|y" file.txt`]],
    [`ls 'dir with & and ;'`, [`ls 'dir with & and ;'`]],
    [`echo "unterminated ; git push`, [`echo "unterminated ; git push`]],
  ] as const)("keeps quoted text whole: %j", (command, parts) => {
    expect(commandParts(command)).toEqual([...parts]);
  });

  test("collects commands inside substitutions and subshells", () => {
    expect(commandParts("echo $(git push origin main)")).toEqual(["git push origin main", "echo $(git push origin main)"]);
    expect(commandParts('echo "today: $(date)"')).toEqual(["date", 'echo "today: $(date)"']);
    expect(commandParts("echo `git push`")).toEqual(["git push", "echo `git push`"]);
    expect(commandParts("(cd sub && git push) | cat")).toEqual(["cd sub", "git push", "cat"]);
    expect(commandParts("diff <(git show HEAD:a) a")).toEqual(["git show HEAD:a", "diff <(git show HEAD:a) a"]);
    expect(commandParts("echo $((1 + 2)); echo ${HOME}")).toEqual(["echo $((1 + 2))", "echo ${HOME}"]);
  });

  test("drops comments, keywords, tests, loop headers and assignments", () => {
    expect(commandParts("ls # and then; git push")).toEqual(["ls"]);
    expect(commandParts("echo a#b")).toEqual(["echo a#b"]);
    expect(commandParts("if [ -f x ]; then git add x; fi")).toEqual(["git add x"]);
    expect(commandParts("[[ -f a && -f b ]] && ls")).toEqual(["ls"]);
    expect(commandParts("for f in *.py; do wc -l $f; done")).toEqual(["wc -l $f"]);
    expect(commandParts("while read l; do echo $l; done < list.txt")).toEqual(["read l", "echo $l"]);
    expect(commandParts("x=$(git log -1); echo $x")).toEqual(["git log -1", "echo $x"]);
    expect(commandParts("f() { git push; }; f")).toEqual(["git push", "f"]);
    expect(commandParts("! git diff --quiet")).toEqual(["git diff --quiet"]);
    expect(commandParts("(( i++ )); ls")).toEqual(["ls"]);
  });

  test("keeps here-document bodies out of the commands", () => {
    const command = "cat > deploy.sh <<'EOF'\ngit push origin main\nEOF\nchmod +x deploy.sh";
    expect(commandParts(command)).toEqual(["cat > deploy.sh <<'EOF'", "chmod +x deploy.sh"]);
    expect(commandParts("cat <<-END\n\tgit push\n\tEND\nls")).toEqual(["cat <<-END", "ls"]);
    expect(commandParts('cat <<< "git push"; ls')).toEqual(['cat <<< "git push"', "ls"]);
  });

  test("withoutAssignments strips leading NAME=value words", () => {
    expect(withoutAssignments("GIT_DIR=x git push")).toBe("git push");
    expect(withoutAssignments(`A="a b" B=$(pwd) git push`)).toBe("git push");
    expect(withoutAssignments("git push X=1")).toBe("git push X=1");
    expect(withoutAssignments("A=1")).toBe("");
  });

  test("commandForms adds the command without assignments, plain wrappers and git's global options", () => {
    expect(commandForms("git push")).toEqual(["git push"]);
    expect(commandForms("GIT_DIR=x git push")).toEqual(["GIT_DIR=x git push", "git push"]);
    expect(commandForms("env A=1 nohup git push")).toEqual(["env A=1 nohup git push", "git push"]);
    expect(commandForms("git -C ../repo -c user.name=x --no-pager push origin")).toEqual([
      "git -C ../repo -c user.name=x --no-pager push origin",
      "git push origin",
    ]);
    expect(commandForms("sudo git -C /srv/repo status")).toEqual(["sudo git -C /srv/repo status", "git -C /srv/repo status", "git status"]);
  });
});

describe("checkShellCommand", () => {
  test("builders and the reviewer may not change git state or use gh; reads are fine", () => {
    for (const agent of ["builder", "builder-deep", "reviewer"]) {
      expect(blocked(agent, "git push")).toBe("git push");
      expect(blocked(agent, "git push --force origin main")).toBe("git push --force origin main");
      expect(blocked(agent, "git commit -am wip")).toBe("git commit -am wip");
      expect(blocked(agent, "git status")).toBeUndefined();
      expect(blocked(agent, "git diff HEAD~1")).toBeUndefined();
      expect(blocked(agent, "bun test")).toBeUndefined();
    }
    expect(blocked("builder", "gh pr view 12")).toBe("gh pr view 12");
    expect(blocked("reviewer", "gh pr view 12")).toBeUndefined();
    expect(blocked("reviewer", "gh pr merge 12")).toBe("gh pr merge 12");
  });

  test("compound commands are checked part by part", () => {
    expect(blocked("builder", "bun test && git add -A && git commit -m done")).toBe("git add -A");
    expect(blocked("builder", "cd sub; git push")).toBe("git push");
    expect(blocked("builder", "make | tee log\ngit tag v1")).toBe("git tag v1");
    expect(blocked("builder", "echo $(git stash)")).toBe("git stash");
  });

  test("assignments, plain wrappers and git's global options do not hide a denied command", () => {
    expect(blocked("builder", "GIT_DIR=x git push")).toBe("GIT_DIR=x git push");
    expect(blocked("builder", "git -C ../other push origin main")).toBe("git -C ../other push origin main");
    expect(blocked("builder", "env GIT_TRACE=1 git commit -m x")).toBe("env GIT_TRACE=1 git commit -m x");
    expect(blocked("builder", "command gh pr create")).toBe("command gh pr create");
    expect(blocked("builder", "git -C sub status")).toBeUndefined();
    expect(blocked("builder", "git --no-pager log -3")).toBeUndefined();
    expect(blocked("builder", "env | grep PATH")).toBeUndefined();
    expect(checkShellCommand(harness, "builder", "git -C x push", "linux")?.message).toContain("lead handles git and GitHub");
  });

  test("quoted text, comments and here-documents do not count as commands", () => {
    expect(blocked("builder", `echo "remember to git push later; git commit"`)).toBeUndefined();
    expect(blocked("builder", `grep -rn 'git push' docs/`)).toBeUndefined();
    expect(blocked("builder", "bun test # then git push")).toBeUndefined();
    expect(blocked("builder", "cat > note.md <<EOF\ngit push origin main\nEOF")).toBeUndefined();
  });

  test("scouts may run only their read-only commands", () => {
    expect(blocked("scout", "git log --oneline -5")).toBeUndefined();
    expect(blocked("scout", "ls -la src")).toBeUndefined();
    expect(blocked("scout", "cd src && ls")).toBeUndefined();
    expect(blocked("scout", "ls 'a;b'")).toBeUndefined();
    expect(blocked("scout", "for f in a b; do wc -l $f; done")).toBeUndefined();
    expect(blocked("scout", "git log | head -3")).toBe("head -3");
    expect(blocked("scout", "rm -rf build")).toBe("rm -rf build");
    expect(blocked("scout-deep", "git push")).toBe("git push");
    expect(blocked("scout", "FOO=1 ls")).toBe("FOO=1 ls");
  });

  test("lead, opencode's own agents, unknown agents and an unknown session are left alone", () => {
    for (const agent of ["lead", "build", "plan", "general", "my-agent", undefined]) {
      expect(blocked(agent, "git push --force")).toBeUndefined();
      expect(blocked(agent, "rm -rf /")).toBeUndefined();
    }
  });

  test("the message says who may not run what, and what to do", () => {
    expect(checkShellCommand(harness, "builder", "git push origin main", "linux")?.message).toBe(
      'ecmwf-multi-agents: helpers may not run "git push origin main"; lead handles git and GitHub. Do not try another way: say in your report what is needed.',
    );
    expect(checkShellCommand(harness, "scout", "rm -rf build", "linux")?.message).toBe(
      'ecmwf-multi-agents: scout may not run "rm -rf build"; its permission rules deny it. Do not try another way: say in your report what is needed.',
    );
    const long = checkShellCommand(harness, "builder", `git commit -m "${"x".repeat(300)}"`, "linux")!.message;
    expect(long.length).toBeLessThan(260);
  });
});
