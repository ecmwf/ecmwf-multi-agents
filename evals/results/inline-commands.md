<!--
SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
SPDX-License-Identifier: Apache-2.0
-->

<!-- Eval runs after the fix for /review and /progress answering inline while other work goes on (opencode 1.x), default profile, opencode 1.18.35, kept for comparison with the next release: the new review-background case (three repeats), then the four inline command cases (one repeat each) to show the common case is unchanged. -->

# Eval summary

- Started 2026-10-12T23:30:57.912Z, finished 2026-10-12T23:33:48.629Z (2m 51s).
- opencode 1.18.35, profile `default`.
- 3 run(s), 3 passed. Total cost $0.881 (limit $6.00).

A run passes when it finished and every counted check passed. Checks in brackets are recorded only and do not decide the result. Cost is what opencode reports for each model request. Peak context is the largest input of one request by the agent that holds the conversation (lead, or build for the baseline), cached tokens included.

## review-background: /review while a background scout works: the review answers inline, the scout's report still wakes lead

| Run | Result | Checks | Cost | Cost per agent | Child sessions | Peak context (main agent) | Requests | Duration |
|---|---|---|---|---|---|---|---|---|
| harness #1 | pass | 4/4 | $0.288 | lead $0.164, scout $0.103, reviewer $0.022 | scout 1 | lead 21,065 | 10 | 1m 18s |
| harness #2 | pass | 4/4 | $0.298 | lead $0.168, scout $0.109, reviewer $0.021 | scout 1 | lead 21,550 | 11 | 1m 26s |
| harness #3 | pass | 4/4 | $0.294 | lead $0.174, scout $0.099, reviewer $0.021 | scout 1 | lead 20,938 | 11 | 1m 32s |

| Check | harness #1 | harness #2 | harness #3 |
|---|---|---|---|
| lead handed off a helper in the background | pass | pass | pass |
| the reviewer answers VERDICT: REJECT naming units.py | pass | pass | pass |
| every background completion in the user's session woke lead | pass | pass | pass |
| the review and the scout changed no project file | pass | pass | pass |

## Totals

| Variant | Runs | Passed | Total cost | Mean cost | Mean duration | Mean peak context |
|---|---|---|---|---|---|---|
| harness | 3 | 3 | $0.881 | $0.294 | 1m 25s | 21,184 |

# Eval summary

- Started 2026-10-12T23:33:49.615Z, finished 2026-10-12T23:35:27.535Z (1m 38s).
- opencode 1.18.35, profile `default`.
- 4 run(s), 4 passed. Total cost $0.315 (limit $6.00).

A run passes when it finished and every counted check passed. Checks in brackets are recorded only and do not decide the result. Cost is what opencode reports for each model request. Peak context is the largest input of one request by the agent that holds the conversation (lead, or build for the baseline), cached tokens included.

## review-reject: /review of an uncommitted change with a real bug

| Run | Result | Checks | Cost | Cost per agent | Child sessions | Peak context (main agent) | Requests | Duration |
|---|---|---|---|---|---|---|---|---|
| harness #1 | pass | 2/2 | $0.022 | reviewer $0.022 | none | lead 0 | 4 | 45s |

| Check | harness #1 |
|---|---|
| the reviewer answers VERDICT: REJECT naming units.py | pass |
| the review changed no project file | pass |

## review-warm: /review after a question to lead, in a session that already has history

| Run | Result | Checks | Cost | Cost per agent | Child sessions | Peak context (main agent) | Requests | Duration |
|---|---|---|---|---|---|---|---|---|
| harness #1 | pass | 2/2 | $0.145 | lead $0.124, reviewer $0.021 | none | lead 16,983 | 8 | 58s |

| Check | harness #1 |
|---|---|
| the reviewer answers VERDICT: REJECT naming units.py | pass |
| the review changed no project file | pass |

## progress: /progress reports a seeded plan's counts and next task

| Run | Result | Checks | Cost | Cost per agent | Child sessions | Peak context (main agent) | Requests | Duration |
|---|---|---|---|---|---|---|---|---|
| harness #1 | pass | 3/3 | $0.029 | scout $0.029 | none | lead 0 | 3 | 25s |

| Check | harness #1 |
|---|---|
| the report says 2 of 5 tasks are done | pass |
| the report names T3, the --json option, as the next task | pass |
| no file changed, plans included | pass |

## progress-warm: /progress after a question to lead, in a session that already has history

| Run | Result | Checks | Cost | Cost per agent | Child sessions | Peak context (main agent) | Requests | Duration |
|---|---|---|---|---|---|---|---|---|
| harness #1 | pass | 3/3 | $0.119 | lead $0.090, scout $0.029 | none | lead 14,778 | 6 | 38s |

| Check | harness #1 |
|---|---|
| the report says 2 of 5 tasks are done | pass |
| the report names T3, the --json option, as the next task | pass |
| no file changed, plans included | pass |

## Totals

| Variant | Runs | Passed | Total cost | Mean cost | Mean duration | Mean peak context |
|---|---|---|---|---|---|---|
| harness | 4 | 4 | $0.315 | $0.079 | 42s | 7,940 |
