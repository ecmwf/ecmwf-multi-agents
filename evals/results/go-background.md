<!--
SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
SPDX-License-Identifier: Apache-2.0
-->

<!-- Eval run on the go-background branch (after 0.3.0), default profile, opencode 1.18.35, three repeats each: plan-go (lead writes and carries out a plan) and plan-go-chat (a seeded five-task plan with two independent tasks, and a question from the user while they run). Kept for comparison with evals/results/0.1.0.md. -->

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
