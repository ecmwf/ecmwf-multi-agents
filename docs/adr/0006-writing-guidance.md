<!--
SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
SPDX-License-Identifier: Apache-2.0
-->

# 0006. Writing guidance for text for people

Status: Accepted. Date: 2026-11-14.

## Context

Users are research scientists, analysts and developers from many countries, and many read
English as a second language (principle 9 in `docs/architecture.md`). `lead`'s prompt asked for
"plain words and short answers", which no model reads the same way and no check can measure.

ASD-STE100 (Simplified Technical English) is a controlled language made for readers whose
first language is not English: an approved dictionary of about 900 words and about 60 writing
rules. Applied in full it reads like a maintenance manual, needs its dictionary, which belongs
to ASD, and models know it only roughly.

## Decisions

- `lead` carries a short `## Writing` section of concrete rules taken from STE's most useful
  ones: one idea per sentence and most sentences under 20 words, the active voice and simple
  tenses, steps as numbered commands, one term for one thing, common words over idioms, saying
  how sure it is, and never changing code, commands, names, paths, quotes or error messages.
  It keeps a natural tone, and clarity comes before any single rule. The section lives in
  `src/fragments/writing.md`, the last part of `lead`'s prompt.
- The rules are for text people read. They do not apply to code, tool input, or briefs to
  helpers, which are tool input.
- The harness calls this STE-inspired writing guidance and never claims STE compliance. The
  STE dictionary is not copied.
- The setting `writing_guidance`, `"plain"` or `"off"`, in user or project settings: with
  `"off"` the plugin removes the section, as it already leaves only the review policy in force.
  `lead` keeps its own "Use plain words and short answers." line, so off is `lead` as it was.
  Without the plugin the section stays.
- `lead` only for now. The helpers that write documents for people (researcher, designer,
  tester) may get a shorter block later, under the same setting, if the evals show a benefit.
- The default is `"plain"`, chosen from evals that ran every case with the setting on and
  off (`evals/results/writing-guidance.md`): no fewer runs passed, `lead` wrote about 5% fewer
  output tokens, its sentences were shorter (9.0 words on average against 10.4) and fewer were
  passive (8% against 13%).

## Consequences

- About 160 more tokens in every `lead` request while the guidance is on: the `lead` budget is
  2050 and `lead-all` 2400. Off saves them.
- A user or a project that prefers `lead` as it was sets `"writing_guidance": "off"`.
- Risks the evals and readers watch for: exact terms replaced by vague ones, a flat tone,
  reasoning lost when sentences are split, and lower task quality on hard tasks.
