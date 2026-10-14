<!--
SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
SPDX-License-Identifier: Apache-2.0
-->

<!-- Eval runs on the go-background branch (after 0.3.0), default profile, opencode 1.18.35: plan-go (lead writes and carries out a plan) and plan-go-chat, since renamed execute-chat (a seeded five-task plan with two independent tasks, and a question from the user while they run), three repeats each; then execute-chat under stricter checks (the answer read from the session messages; both hand-offs begun before the first completion); then, after the rule that lead answers the user before processing completions, execute-chat three times more. Then, on main after the merge (#3), execute-chat with a question that needs a lookup, the quality check's range, three times before and three times after the answer-first wording in the lead prompt and the plan skill: when a completion arrived during the lookup, lead never answered. Then, for 0.5.1, three times with a note from the plugin after such a completion (it did not change that either), and three times with the plugin holding the completion back until lead had answered: all pass, with T1's builder finishing during lead's lookup in each run. These two runs add the check that lead finished the plan without being asked to carry on. Kept for comparison with evals/results/0.1.0.md. The eval runner drives opencode 1.x only. -->

# Eval summary

- Started 2026-10-13T07:42:20.319Z, finished 2026-10-13T07:55:16.200Z (12m 56s).
- opencode 1.18.35, profile `default`.
- 6 run(s), 6 passed. Total cost $5.78 (limit $40.00).

A run passes when it finished and every counted check passed. Checks in brackets are recorded only and do not decide the result. Cost is what opencode reports for each model request. Peak context is the largest input of one request by the agent that holds the conversation (lead, or build for the baseline), cached tokens included.

## plan-go: /plan, approval, then the plan carried out (with /go in a new session if needed)

| Run | Result | Checks | Cost | Cost per agent | Child sessions | Peak context (main agent) | Requests | Duration |
|---|---|---|---|---|---|---|---|---|
| harness #1 | pass | 3/3 | $1.05 | lead $0.790, builder $0.154, reviewer $0.109 | builder 3, reviewer 2 | lead 49,377 | 44 | 5m 06s |
| harness #2 | pass | 3/3 | $1.28 | lead $0.824, builder $0.235, reviewer $0.127, scout $0.098 | builder 3, reviewer 2, scout 1 | lead 48,968 | 56 | 6m 17s |
| harness #3 | pass | 3/3 | $1.08 | lead $0.819, builder $0.165, reviewer $0.093 | builder 2, reviewer 2 | lead 49,163 | 48 | 5m 19s |

| Check | harness #1 | harness #2 | harness #3 |
|---|---|---|---|
| a plan in .ecmwf-multi-agents/plans/ has status done with every task ticked | pass | pass | pass |
| hidden tests pass (evals/hidden/plan-go) | pass | pass | pass |
| the project's tests pass (python3 -m unittest) | pass | pass | pass |
| lead handed off a helper in the background | (pass) | (pass) | (fail) |

- harness #3, lead handed off a helper in the background (recorded only): 0 background hand-off(s) of 4 hand-off(s)

## plan-go-chat: /go on a seeded plan while the user asks a question; the answer comes before the plan ends

| Run | Result | Checks | Cost | Cost per agent | Child sessions | Peak context (main agent) | Requests | Duration |
|---|---|---|---|---|---|---|---|---|
| harness #1 | pass | 5/5 | $0.798 | lead $0.585, builder $0.160, scout $0.052 | builder 4, scout 1 | lead 39,186 | 45 | 2m 45s |
| harness #2 | pass | 5/5 | $0.816 | lead $0.616, builder $0.143, scout $0.057 | builder 4, scout 1 | lead 41,125 | 39 | 3m 10s |
| harness #3 | pass | 5/5 | $0.756 | lead $0.554, builder $0.153, scout $0.048 | builder 4, scout 1 | lead 36,805 | 43 | 2m 30s |

| Check | harness #1 | harness #2 | harness #3 |
|---|---|---|---|
| lead handed off 2 helpers in the background | pass | pass | pass |
| the question was answered while the tasks ran | pass | pass | pass |
| a plan in .ecmwf-multi-agents/plans/ has status done with every task ticked | pass | pass | pass |
| hidden tests pass (evals/hidden/plan-go-chat) | pass | pass | pass |
| the project's tests pass (python3 -m unittest) | pass | pass | pass |

## Totals

| Variant | Runs | Passed | Total cost | Mean cost | Mean duration | Mean peak context |
|---|---|---|---|---|---|---|
| harness | 6 | 6 | $5.78 | $0.964 | 4m 11s | 44,104 |

---

# Eval summary

- Started 2026-10-13T09:40:35.864Z, finished 2026-10-13T09:43:53.412Z (3m 18s).
- opencode 1.18.35, profile `default`.
- 1 run(s), 1 passed. Total cost $0.882 (limit $40.00).

A run passes when it finished and every counted check passed. Checks in brackets are recorded only and do not decide the result. Cost is what opencode reports for each model request. Peak context is the largest input of one request by the agent that holds the conversation (lead, or build for the baseline), cached tokens included.

## execute-chat: /execute on a seeded plan with two tasks ready; the user asks a question while they run and lead answers it

| Run | Result | Checks | Cost | Cost per agent | Child sessions | Peak context (main agent) | Requests | Duration |
|---|---|---|---|---|---|---|---|---|
| harness #1 | pass | 6/6 | $0.882 | lead $0.674, builder $0.153, scout $0.055 | builder 4, scout 1 | lead 43,536 | 44 | 3m 18s |

| Check | harness #1 |
|---|---|
| lead handed off 2 helpers in the background | pass |
| 2 background hand-offs ran at the same time | pass |
| lead answered the question before the next completion arrived | pass |
| a plan in .ecmwf-multi-agents/plans/ has status done with every task ticked | pass |
| hidden tests pass (evals/hidden/feature) | pass |
| the project's tests pass (python3 -m unittest) | pass |

## Totals

| Variant | Runs | Passed | Total cost | Mean cost | Mean duration | Mean peak context |
|---|---|---|---|---|---|---|
| harness | 1 | 1 | $0.882 | $0.882 | 3m 18s | 43,536 |

---

# Eval summary

- Started 2026-10-13T12:57:46.531Z, finished 2026-10-13T13:04:02.574Z (6m 16s).
- opencode 1.18.35, profile `default`.
- 3 run(s), 3 passed. Total cost $2.60 (limit $40.00).

A run passes when it finished and every counted check passed. Checks in brackets are recorded only and do not decide the result. Cost is what opencode reports for each model request. Peak context is the largest input of one request by the agent that holds the conversation (lead, or build for the baseline), cached tokens included.

## execute-chat: /execute on a seeded plan with two tasks ready; the user asks a question while they run and lead answers it

| Run | Result | Checks | Cost | Cost per agent | Child sessions | Peak context (main agent) | Requests | Duration |
|---|---|---|---|---|---|---|---|---|
| harness #1 | pass | 6/6 | $0.895 | lead $0.654, builder $0.183, scout $0.058 | builder 4, scout 1 | lead 42,159 | 47 | 3m 27s |
| harness #2 | pass | 6/6 | $0.792 | lead $0.578, builder $0.161, scout $0.053 | builder 4, scout 1 | lead 38,382 | 45 | 2m 56s |
| harness #3 | pass | 6/6 | $0.909 | lead $0.670, builder $0.186, scout $0.054 | builder 4, scout 1 | lead 43,248 | 44 | 3m 20s |

| Check | harness #1 | harness #2 | harness #3 |
|---|---|---|---|
| lead handed off 2 helpers in the background | pass | pass | pass |
| 2 background hand-offs ran at the same time | pass | pass | pass |
| lead answered the question while helpers were still running | pass | pass | pass |
| a plan in .ecmwf-multi-agents/plans/ has status done with every task ticked | pass | pass | pass |
| hidden tests pass (evals/hidden/feature) | pass | pass | pass |
| the project's tests pass (python3 -m unittest) | pass | pass | pass |

## Totals

| Variant | Runs | Passed | Total cost | Mean cost | Mean duration | Mean peak context |
|---|---|---|---|---|---|---|
| harness | 3 | 3 | $2.60 | $0.865 | 3m 14s | 41,263 |

---

# Eval summary

- Started 2026-10-14T10:03:53.547Z, finished 2026-10-14T10:10:27.366Z (6m 34s).
- opencode 1.18.35, profile `default`.
- 3 run(s), 0 passed. Total cost $2.55 (limit $5.00).

A run passes when it finished and every counted check passed. Checks in brackets are recorded only and do not decide the result. Cost is what opencode reports for each model request. Peak context is the largest input of one request by the agent that holds the conversation (lead, or build for the baseline), cached tokens included.

## execute-chat: /execute on a seeded plan with two tasks ready; the user asks a question while they run and lead answers it

| Run | Result | Checks | Cost | Cost per agent | Child sessions | Peak context (main agent) | Requests | Duration |
|---|---|---|---|---|---|---|---|---|
| harness #1 | FAIL | 5/6 | $0.918 | lead $0.680, builder $0.182, scout $0.057 | builder 4, scout 1 | lead 43,025 | 42 | 4m 03s |
| harness #2 | FAIL | 5/6 | $0.814 | lead $0.607, builder $0.159, scout $0.048 | builder 4, scout 1 | lead 41,140 | 45 | 3m 14s |
| harness #3 | FAIL | 5/6 | $0.822 | lead $0.611, builder $0.157, scout $0.053 | builder 4, scout 1 | lead 42,698 | 41 | 3m 19s |

| Check | harness #1 | harness #2 | harness #3 |
|---|---|---|---|
| lead handed off 2 helpers in the background | pass | pass | pass |
| 2 background hand-offs ran at the same time | pass | pass | pass |
| lead answered the question while helpers were still running | FAIL | FAIL | FAIL |
| a plan in .ecmwf-multi-agents/plans/ has status done with every task ticked | pass | pass | pass |
| hidden tests pass (evals/hidden/feature) | pass | pass | pass |
| the project's tests pass (python3 -m unittest) | pass | pass | pass |

- harness #1, lead answered the question while helpers were still running: no answer names -90, 60
- harness #2, lead answered the question while helpers were still running: no answer names -90, 60
- harness #3, lead answered the question while helpers were still running: no answer names -90, 60

## Totals

| Variant | Runs | Passed | Total cost | Mean cost | Mean duration | Mean peak context |
|---|---|---|---|---|---|---|
| harness | 3 | 0 | $2.55 | $0.851 | 3m 32s | 42,288 |

---

# Eval summary

- Started 2026-10-14T10:18:38.910Z, finished 2026-10-14T10:25:49.183Z (7m 10s).
- opencode 1.18.35, profile `default`.
- 3 run(s), 1 passed. Total cost $2.55 (limit $5.00).

A run passes when it finished and every counted check passed. Checks in brackets are recorded only and do not decide the result. Cost is what opencode reports for each model request. Peak context is the largest input of one request by the agent that holds the conversation (lead, or build for the baseline), cached tokens included.

## execute-chat: /execute on a seeded plan with two tasks ready; the user asks a question while they run and lead answers it

| Run | Result | Checks | Cost | Cost per agent | Child sessions | Peak context (main agent) | Requests | Duration |
|---|---|---|---|---|---|---|---|---|
| harness #1 | FAIL | 5/6 | $0.849 | lead $0.640, builder $0.155, scout $0.054 | builder 4, scout 1 | lead 42,975 | 45 | 3m 55s |
| harness #2 | FAIL | 5/6 | $0.865 | lead $0.655, builder $0.158, scout $0.053 | builder 4, scout 1 | lead 42,614 | 43 | 3m 56s |
| harness #3 | pass | 6/6 | $0.839 | lead $0.641, builder $0.149, scout $0.049 | builder 4, scout 1 | lead 42,209 | 45 | 3m 15s |

| Check | harness #1 | harness #2 | harness #3 |
|---|---|---|---|
| lead handed off 2 helpers in the background | pass | pass | pass |
| 2 background hand-offs ran at the same time | pass | pass | pass |
| lead answered the question while helpers were still running | FAIL | FAIL | pass |
| a plan in .ecmwf-multi-agents/plans/ has status done with every task ticked | pass | pass | pass |
| hidden tests pass (evals/hidden/feature) | pass | pass | pass |
| the project's tests pass (python3 -m unittest) | pass | pass | pass |

- harness #1, lead answered the question while helpers were still running: no answer names -90, 60
- harness #2, lead answered the question while helpers were still running: no answer names -90, 60

## Totals

| Variant | Runs | Passed | Total cost | Mean cost | Mean duration | Mean peak context |
|---|---|---|---|---|---|---|
| harness | 3 | 1 | $2.55 | $0.851 | 3m 42s | 42,599 |

---

# Eval summary

- Started 2026-10-14T11:51:55.454Z, finished 2026-10-14T11:58:25.079Z (6m 30s).
- opencode 1.18.35, profile `default`.
- 3 run(s), 1 passed. Total cost $2.33 (limit $5.00).

A run passes when it finished and every counted check passed. Checks in brackets are recorded only and do not decide the result. Cost is what opencode reports for each model request. Peak context is the largest input of one request by the agent that holds the conversation (lead, or build for the baseline), cached tokens included.

## execute-chat: /execute on a seeded plan with two tasks ready; the user asks a question while they run and lead answers it

| Run | Result | Checks | Cost | Cost per agent | Child sessions | Peak context (main agent) | Requests | Duration |
|---|---|---|---|---|---|---|---|---|
| harness #1 | FAIL | 6/7 | $0.759 | lead $0.549, builder $0.159, scout $0.051 | builder 4, scout 1 | lead 37,731 | 43 | 3m 10s |
| harness #2 | pass | 7/7 | $0.759 | lead $0.559, builder $0.151, scout $0.049 | builder 4, scout 1 | lead 38,673 | 47 | 3m 36s |
| harness #3 | FAIL | 6/7 | $0.808 | lead $0.615, builder $0.146, scout $0.046 | builder 4, scout 1 | lead 41,150 | 42 | 3m 19s |

| Check | harness #1 | harness #2 | harness #3 |
|---|---|---|---|
| lead handed off 2 helpers in the background | pass | pass | pass |
| 2 background hand-offs ran at the same time | pass | pass | pass |
| lead answered the question while helpers were still running | FAIL | pass | FAIL |
| lead finished the plan without being asked to carry on | pass | pass | pass |
| a plan in .ecmwf-multi-agents/plans/ has status done with every task ticked | pass | pass | pass |
| hidden tests pass (evals/hidden/feature) | pass | pass | pass |
| the project's tests pass (python3 -m unittest) | pass | pass | pass |

- harness #1, lead answered the question while helpers were still running: no answer names -90, 60
- harness #3, lead answered the question while helpers were still running: no answer names -90, 60

## Totals

| Variant | Runs | Passed | Total cost | Mean cost | Mean duration | Mean peak context |
|---|---|---|---|---|---|---|
| harness | 3 | 1 | $2.33 | $0.775 | 3m 22s | 39,185 |

---

# Eval summary

- Started 2026-10-14T12:37:28.579Z, finished 2026-10-14T12:44:09.863Z (6m 41s).
- opencode 1.18.35, profile `default`.
- 3 run(s), 3 passed. Total cost $2.43 (limit $5.00).

A run passes when it finished and every counted check passed. Checks in brackets are recorded only and do not decide the result. Cost is what opencode reports for each model request. Peak context is the largest input of one request by the agent that holds the conversation (lead, or build for the baseline), cached tokens included.

## execute-chat: /execute on a seeded plan with two tasks ready; the user asks a question while they run and lead answers it

| Run | Result | Checks | Cost | Cost per agent | Child sessions | Peak context (main agent) | Requests | Duration |
|---|---|---|---|---|---|---|---|---|
| harness #1 | pass | 7/7 | $0.851 | lead $0.645, builder $0.156, scout $0.050 | builder 4, scout 1 | lead 42,015 | 45 | 3m 50s |
| harness #2 | pass | 7/7 | $0.801 | lead $0.579, builder $0.165, scout $0.057 | builder 4, scout 1 | lead 39,273 | 44 | 3m 13s |
| harness #3 | pass | 7/7 | $0.779 | lead $0.590, builder $0.142, scout $0.048 | builder 4, scout 1 | lead 38,935 | 44 | 3m 27s |

| Check | harness #1 | harness #2 | harness #3 |
|---|---|---|---|
| lead handed off 2 helpers in the background | pass | pass | pass |
| 2 background hand-offs ran at the same time | pass | pass | pass |
| lead answered the question while helpers were still running | pass | pass | pass |
| lead finished the plan without being asked to carry on | pass | pass | pass |
| a plan in .ecmwf-multi-agents/plans/ has status done with every task ticked | pass | pass | pass |
| hidden tests pass (evals/hidden/feature) | pass | pass | pass |
| the project's tests pass (python3 -m unittest) | pass | pass | pass |

## Totals

| Variant | Runs | Passed | Total cost | Mean cost | Mean duration | Mean peak context |
|---|---|---|---|---|---|---|
| harness | 3 | 3 | $2.43 | $0.811 | 3m 30s | 40,074 |
