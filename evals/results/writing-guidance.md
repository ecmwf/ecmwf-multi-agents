<!--
SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
SPDX-License-Identifier: Apache-2.0
-->

<!-- The writing guidance (ADR 0006) on and off, on the build with PR #8 merged: real models, default profile, opencode 2.2.6, harness variant, 2026-11-14. Every case once with "writing_guidance": "plain" and once with "off" (bun evals/run.ts --writing), and the 7 text-heavy cases (answer, investigate, inventory, plan-execute, progress, review-reject, onboard) twice more each way. Measures from bun evals/readability.ts over lead's final answers. $37.94 in all, of $45 approved. -->

# Writing guidance on and off

## All cases once each way, and the text-heavy cases twice more

| Measure | on | off |
|---|---|---|
| Runs passed | 40 of 42 (95%) | 39 of 42 (93%) |
| lead output tokens per run | 2985 | 3134 |
| Cost | $15.24 | $17.85 |
| Sentences in lead's answers | 1135 | 1002 |
| Words per sentence, mean | 9.0 | 10.4 |
| Words per sentence, 90th percentile | 16 | 19 |
| Sentences over 30 words | 0% | 0% |
| Passive sentences | 8% | 13% |
| Em dashes | 2 | 1 |

## The 7 text-heavy cases, 3 runs each way

| Measure | on | off |
|---|---|---|
| Runs passed | 21 of 21 (100%) | 20 of 21 (95%) |
| lead output tokens per run | 3241 | 3358 |
| Cost | $4.76 | $4.55 |
| Sentences in lead's answers | 569 | 513 |
| Words per sentence, mean | 8.5 | 9.9 |
| Words per sentence, 90th percentile | 15 | 18 |
| Sentences over 30 words | 0% | 1% |
| Passive sentences | 8% | 13% |
| Em dashes | 0 | 0 |

## Failed runs

- On: `researcher-compare` (the researcher's report had no experiments section) and
  `designer-limit-twice` (lead offered the higher step limit in prose, not with the question
  tool). Off: `investigate` (the answer did not name the duplicate), `data-question` (no script
  kept), `designer-limit` (lead wrote the spec itself). Different cases failed in each arm, and
  the helpers' prompts are the same in both, so these read as run-to-run variation, except the
  step-limit offer: the plugin's note reached lead once, and lead put the question off and
  forgot it.
- Fix: the note stays in lead's requests until lead uses the question tool or its turn ends.
  `designer-limit-twice` with the guidance on, twice after the fix:

- Started 2026-11-14T16:09:10.755Z, finished 2026-11-14T16:20:46.088Z (11m 35s).
- opencode 2.2.6, profile `default`, writing guidance `plain`.
- 2 run(s), 2 passed. Total cost $4.85 (limit $6.00).

A run passes when it finished and every counted check passed. Checks in brackets are recorded only and do not decide the result. Cost is what opencode reports for each model request. Peak context is the largest input of one request by the agent that holds the conversation (lead, or build for the baseline), cached tokens included.

## designer-limit-twice: With designer on and a very low step limit: it reaches the limit twice in one session, and lead offers a higher limit through the question tool

| Run | Result | Checks | Cost | Cost per agent | Child sessions | Peak context (main agent) | Requests | Duration |
|---|---|---|---|---|---|---|---|---|
| harness #1 | pass | 5/5 | $2.71 | designer $2.15, lead $0.554 | designer 1 | lead 44,796 | 38 | 11m 35s |
| harness #2 | pass | 5/5 | $2.14 | designer $1.73, lead $0.411 | designer 1 | lead 29,102 | 26 | 9m 54s |

| Check | harness #1 | harness #2 |
|---|---|---|
| no request of designer ended in an error | pass | pass |
| lead continued the designer's session | pass | pass |
| lead asked whether to raise the designer's step limit | pass | pass |
| the project's settings raise the designer's step limit above 6 | pass | pass |
| no project file changed (work files and the project's settings allowed) | pass | pass |

## Totals

| Variant | Runs | Passed | Total cost | Mean cost | Mean duration | Mean peak context |
|---|---|---|---|---|---|---|
| harness | 2 | 2 | $4.85 | $2.42 | 10m 44s | 36,949 |

## Decision

The owner chose `"plain"` as the default, after reading answers side by side.
