// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { commandParts, withoutAssignments } from "./command-parts.ts";

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
});
