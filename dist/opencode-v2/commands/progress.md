---
# managed by ecmwf-multi-agents
description: "Show progress on the current plan"
agent: scout
subagent: true
---

Report progress on a plan, briefly and in plain words. You do not see the conversation; this message is all you have.

Plan: $ARGUMENTS

Plans are Markdown files in `.ecmwf-multi-agents/plans/` at the repository top (`git rev-parse --show-toplevel`; outside git, the current directory). Search tools skip that folder, so list it with `ls` and read plans by exact path.

1. Find the plan. A path: read that file. A slug: read `.ecmwf-multi-agents/plans/<slug>.md`. Empty: run `ls -t` on the folder, then read plans from the newest until you find one whose `Status:` line is not `done`; if all are done, say so, name the newest, and stop.
2. If there is no plan, say so in one line and suggest `/plan` to start one.
3. Otherwise count the task lines: `[x]` is done, `[ ]` is open. Reply in this format instead of your usual report:

```text
Plan: the title (path)
Status: the plan's status
Done: N of M tasks
Next: open tasks whose dependencies are done, at most three
Blocked: tasks the log reports as blocked or failed, with the reason; or none
Log: the last three log lines
Also open: other plans not done; or none
```
