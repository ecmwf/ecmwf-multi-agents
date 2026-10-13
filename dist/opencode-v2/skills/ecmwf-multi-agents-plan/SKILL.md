---
# managed by ecmwf-multi-agents
name: ecmwf-multi-agents-plan
description: "Plan file format and rules for ecmwf-multi-agents. Use when writing, updating or carrying out a plan in .ecmwf-multi-agents/plans/."
metadata:
  opencode/autoinvoke: "false"
---

# Plans

How you plan work with the user and carry out an approved plan. A plan lives in `.ecmwf-multi-agents/plans/<slug>.md` at the top of the repository; the slug is a few lowercase words joined by hyphens, not used by another plan. Search tools skip this folder, so read and write plans by exact path. The plan file is the memory of the work: keep it complete enough for a fresh session to continue from it alone.

## Planning

1. Clarify the goal, scope and constraints with the user until the intent is clear. Use the question tool, a few questions at a time, with your recommended option first. Look up facts instead of asking for them.
2. Send scouts in parallel for the facts you still need: relevant files, callers, conventions, build and test commands.
3. Write the plan file in the format below, with status `draft`, after the git exclude check in your instructions. Make each task small enough for one helper to finish from its brief alone.
4. Review as the review policy in your instructions says. `auto` or `always`: brief the reviewer with the plan's path and goal. `ask`: ask the user first. `never`: skip. On REJECT, revise the plan and send it back with the blockers, at most two rounds; then put the open blockers to the user.
5. Explain the plan in plain words: what will change, the tasks, the risks and your assumptions.
6. Stop and wait. Set status `approved`, with a log line, only when the user approves. If the user asks for changes, revise and explain again. Once approved, carry the plan out if the user wants it now; otherwise say that `/go` runs it later, even in a new session.

## Plan file format

Example:

```markdown
# Add CSV export to the report tool

Status: draft
Goal: users can save a report as a CSV file from the command line.
Created: 2026-10-11

## Context
- Decision: use the standard csv module, no new dependency (user).
- Report rows are built in `src/report.py:120`.
- Assumption: columns keep the order of the on-screen table.

## Out of scope
- Excel output.

## Tasks
- [ ] T1 Write the CSV writer. Agent: builder. Files: `src/export.py`, `tests/test_export.py`. Depends on: none.
  DONE WHEN: 1. `write_csv(rows, path)` writes a header and one line per row. 2. A test covers an empty report.
  CHECKS: `pytest tests/test_export.py`
- [ ] T2 Document the option. Agent: builder. Files: `docs/usage.md`. Depends on: none.
  DONE WHEN: 1. The usage page shows `report --csv out.csv` with an example.
- [ ] T3 Add the `--csv` option. Agent: builder. Files: `src/cli.py`. Depends on: T1.
  DONE WHEN: 1. `report --csv out.csv` writes the file. 2. Without `--csv` the output is unchanged.
  CHECKS: `pytest`

Parallel: T1 and T2.

## Final verification
- `pytest` and `ruff check .` pass.
- `report --csv /tmp/r.csv` on the sample data writes 3 lines.

## Log
- 2026-10-11: Plan written. Reviewer: APPROVE.
```

Status is one of draft, approved, in progress, done, stopped. Context holds decisions, constraints, findings with `path:line` and assumptions. Agent is builder or scout. Files are the paths the task may change (for scouts, the paths to read). Parallel lists tasks that share no files and do not depend on each other.

## Carrying out a plan

1. Read the plan by exact path. Carry out only an approved, in progress or stopped plan; a draft needs the user's approval first. When resuming, read the log and check `git status` for unfinished work; helpers of an earlier session are gone. Set status `in progress` and add a log line.
2. The ready tasks are the open ones whose dependencies are ticked. Brief each from its own lines plus the plan's context and goal. LIMITS: change only the listed files; stop and report if the task needs more.
3. Hand ready tasks off in the background when two or more are ready, or when the user may want to keep talking; otherwise one task runs in the foreground. At most three helpers at once. If the platform refuses a background hand-off, run the ready tasks together in the foreground and wait.
4. Read every completion that has arrived before starting new work. Check each report against its DONE WHEN items and re-run cheap checks yourself.
5. On success, tick the task, add a dated log line, put a scout task's findings in the context, tell the user in one line, and start the tasks that became ready. On failure, log it and brief the same agent again with the gap stated exactly, the same way as the first attempt; for a builder, also say what the earlier attempt changed. If it fails again, stop and take it to the user. Never brief a task whose helper is still running.
6. Stop when all tasks are done, when a task is blocked or fails twice, or after three failed reports in a row. After a stop, start nothing new; let running helpers finish and tick those that pass.
7. When all tasks are done, run the final verification in the foreground (if it fails, add a fix task and carry it out as above), then one review of the whole change, as the policy calls for; tasks get no review of their own.
8. Set status `done` when the verification and any review pass; otherwise `stopped`, with the reason in the log. Report to the user: what changed, what was checked, what was not, and what comes next.

A change of scope or approach after approval goes back to the user before you act. Record the decision in the plan's context and log.
