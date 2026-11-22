<!--
SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
SPDX-License-Identifier: Apache-2.0
-->

<!-- The security skills (ADR 0007, docs/research/security-skills.md) allowed and denied, on
the 0.11.0 release branch: real models, default profile, opencode 2.2.6, harness variant,
2026-11-22. The cases harden-code, harden-supply and harden-fix, 3 runs with the skills allowed
and 3 with them denied to the inspector and the builder (bun evals/run.ts --skills on|off).
$41.02 in all, no cost limit. Scored with the checks that count a finding by its words or the
place it points at, re-run over the saved runs; every decoy mention was also read by hand. -->

# Security skills allowed and denied

## Finding the weaknesses

| Measure | Allowed | Denied |
|---|---|---|
| `harden-code`: weaknesses found (unfiltered `extractall`, `mktemp`, `memset` before `free`) | 9 of 9 | 9 of 9 |
| `harden-supply`: weaknesses found (cache in the release job, long-lived PyPI token, extra package index) | 9 of 9 | 8 of 9 |
| Decoys reported as findings (2 per `harden-code` run, 1 per `harden-supply` run) | 0 of 9 | 0 of 9 |
| Runs whose findings or reports cite checklist IDs | 6 of 6 | 0 of 6 |
| Runs where the inspector loaded the skills | 6 of 6 | 0 of 6 (refused) |

The one miss: in the third run without the skills, the inspector weighed the release cache and
set it aside ("no untrusted writer to a release-visible cache was established"). The
supply-chain checklist makes this a rule (GA6: no cache in a release or publishing job), and all
three runs with it reported the cache.

Each arm had one run whose findings named the decoy `unpack_checked`. Both were advice to reuse
it for the unsafe `unpack`, not findings about it.

## Fixing (`harden-fix`)

| Measure | Allowed | Denied |
|---|---|---|
| Runs passed: a `fix(security)` commit, `shell=True` gone, hidden tests, a regression test, nothing silenced, tests pass, nothing pushed | 3 of 3 | 3 of 3 |
| Fixed in the shared helper `_run`, so both callers are safe | 3 of 3 | 3 of 3 |
| Runs where the builder loaded the fix skill | 3 of 3 | 0 of 3 (refused) |

## Cost and time

| Case | Allowed | Denied |
|---|---|---|
| `harden-code`, 3 runs | $8.03, 11.4 min per run | $7.60, 10.7 min per run |
| `harden-supply`, 3 runs | $6.97, 9.3 min per run | $6.30, 9.1 min per run |
| `harden-fix`, 3 runs | $6.54, 11.2 min per run | $5.57, 9.7 min per run |
| All 9 runs | $21.54 | $19.48 |
| Of which the inspector | $13.23 | $11.60 |

With the skills, a run cost about 10% more, mostly the inspector reading the checklists and
citing them.

## Reading

- On these planted weaknesses the model found almost everything without the skills: 17 of 18
  against 18 of 18. With 3 runs per arm, one miss is not a significant difference.
- What the skills reliably add is traceability: every finding names the checklist rule behind
  it, and the user can look it up. The one miss was a judgement call that a checklist rule
  settles.
- The planted weaknesses are well known. The code checklist's items for scientific Python
  (`torch.load`, `numpy.load` with `allow_pickle`), Fortran and HPC are not measured here.

## How the runs were scored

The first scoring matched exact words and misjudged 5 of the 18 runs: findings that described a
weakness in other words, or as a table without a `WHERE:` label, advice that named a decoy, and
IDs cited only in the report file. The checks now count a weakness as found when a finding
names it or its place covers the planted line, a decoy only when a finding points at its lines,
and IDs in the findings or the report files under `.ecmwf-multi-agents/security/`. Re-run over
the saved runs, they agree with a reading by hand in all 18.

## Decision

All three skills ship in 0.11.0, for the traceability of the findings and the rules that settle
judgement calls. Issue #26 measures the code skill on weaknesses a model is more likely to miss.
