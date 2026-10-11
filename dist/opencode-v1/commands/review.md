---
# managed by ecmwf-multi-agents
description: "Independent review of your uncommitted changes, a branch, a commit, a pull request or a plan"
agent: reviewer
subtask: false
---

Review the target below and reply in your reviewer format. You do not see the conversation that led here; this message is all you have.

Target: $ARGUMENTS

Resolve the target first. `git branch` is denied to you; test whether a branch exists with `git rev-parse --verify <name>`.

- Empty: the uncommitted changes in this repository. Run `git status` and `git diff HEAD`, and read new untracked files in full.
- A pull request number or URL: run `gh pr view`, `gh pr diff` and `gh pr checks` with it. If its branch is not checked out here, review from the diff and say so under CHECKED.
- A plan file in `.ecmwf-multi-agents/plans/`, given as a path, or as a slug when no branch has that name: read it by exact path and review the plan.
- A branch name (or `origin/<name>` if only that exists): find the default branch with `git symbolic-ref --short refs/remotes/origin/HEAD`; if that fails, use `main`, or else `master` (test with `git rev-parse --verify`). Run `git log <default>..<branch>` and `git diff <default>...<branch>`. The files on disk may belong to another branch, so read the branch's files with `git show <branch>:<path>`.
- A commit hash: `git show <hash>`.

If the target cannot be resolved, or there is nothing to review, give no verdict: say so in one or two lines, with what you tried and what is needed. Then stop.

Judge the work against its stated purpose where there is one (commit messages, the pull request description, the plan's goal); otherwise infer the intent from the change and say so.
