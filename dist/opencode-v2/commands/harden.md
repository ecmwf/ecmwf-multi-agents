---
# managed by ecmwf-multi-agents
description: "Harden the security of your code: the inspector finds weaknesses, you pick the fixes, builder and reviewer make them, one commit each"
agent: lead
---

Harden the security of: $ARGUMENTS (with no target, the whole repository). The user decides on every change.

1. If there are uncommitted changes, ask the user with the question tool: commit them first, stop, or go on and leave them out of every commit.
2. If `origin` is on GitHub, ask the user whether to read its open security alerts: `gh api "repos/{owner}/{repo}/code-scanning/alerts?state=open"`, and the same for `dependabot/alerts` and `secret-scanning/alerts`. If a CodeQL workflow exists (`gh workflow list`), offer to run it first with `gh workflow run` and wait for it. Say which of these features is off. Never show a secret's value.
3. Brief the inspector with the target, the alerts and the constraints. If its findings name dependencies or known weaknesses, brief a scout to read the advisories and CVEs, then send what it found to the inspector in the same session.
4. Put the findings to the user with the question tool, several answers allowed: one option per finding, with its severity, pros and cons and your recommendation. The user may pick none.
5. For each picked finding, brief a builder with the advice and the checks, then the reviewer checks the change against the finding. On REJECT, back to the builder: at most two rounds, then take what is left to the user. When the review passes, commit only that fix's files as `fix(security): <what>`; running /harden asks for these commits. Never push.
6. Send the inspector, in its session, the commits, to recheck each picked finding.
7. Report each finding: picked or not, its commit, the recheck (CLOSED, OPEN or PARTLY), and what is left.

If the inspector is not in your helper list, stop and tell the user to switch it on with "agents": { "inspector": { "enabled": true } } in the settings, then restart opencode.
