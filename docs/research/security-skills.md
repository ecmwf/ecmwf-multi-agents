<!--
SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
SPDX-License-Identifier: Apache-2.0
-->

# Security skills: what to learn from cybersecurity-skills

Read on 2026-11-22 for the inspector and `/harden` (ADR 0007): https://github.com/briiirussell/cybersecurity-skills,
MIT licence, by Bri Russell, version 1.99.2, 42 skills. Nothing is copied: the harness's three
security skills are its own text, inspired by the method there and written for our users.

## What it is

Each skill is `skills/<name>/SKILL.md` with a `references/` folder; shared files (findings format,
severity rules, verification) are copied into each skill at build time. One `SKILL.md` is about
1,100 to 13,000 tokens, up to about 60,000 with its references: 3 to 30 times our skill budget.
Most skills target web apps and SaaS (OWASP, Next.js, Rails, cloud accounts); several act on
live systems (recon, pentests, using a found key with its provider, cloud account reads) or read
files outside the repository, which the inspector's "advise only, never touch real services"
rules forbid. Its `allowed-tools` frontmatter is Claude Code only; opencode does not enforce it.

## What is worth borrowing

- Rating (`shared/severity-calibration.md`, `shared/verification.md`): a finding needs a named
  attacker, the input they control, the control that should stop them, the boundary crossed and
  a concrete result; otherwise it is a hardening note without severity. Severity never above the
  impact shown; a static-only trace caps confidence at medium. "Internal" or "tests pass" do not
  rule a finding out; a hard-coded fallback secret is confirmed, not a guess.
- GitHub Actions (`cicd-security`): untrusted code under `pull_request_target`/`workflow_run`,
  expression injection into `run:` (fix: `env:` and `"$VAR"`), permissions, unpinned actions
  (workflow lockfiles count as pinning), caches in release jobs, publishing with long-lived
  tokens, and a list of safe shapes that are not findings.
- Python supply chain (`dependency-audit`): `--extra-index-url` as the classic dependency
  confusion setup, `--require-hashes`, `.pth` and `sitecustomize.py` startup hooks (found with
  `find`, never by starting Python).
- Secrets (`secrets-audit`): never print a value; give type, place and a short prefix; rotate
  first, rewrite history second, and both are the owner's steps.
- Scanner hits (`scanner-pipeline`): a hit is a candidate until confirmed in the code; never
  edit scanner config to make a finding go away.
- Fix verification (`finding-triage/references/fix-verification.md`): a fix that only moved the
  problem (guard on one path only, a denylist of the known payload, failing open, a sibling
  sink such as `os.system` to `shell=True`) is not a fix; a regression test must fail before it.

## What it lacks for our users

Almost nothing on scientific Python (`pickle`, `joblib`, `torch.load`, `numpy.load` with
`allow_pickle`, `yaml.load`, `tarfile.extractall`, `tempfile.mktemp`), Fortran, shell scripts
beyond shellcheck, HPC (Slurm, shared scratch, Apptainer). The harness's skills add these.

## Decision

Three skills of our own, each within the skill budget, with an ID per checklist item that the
inspector cites in its findings: `ecmwf-multi-agents-security-code` and
`ecmwf-multi-agents-security-supply-chain` for the inspector, `ecmwf-multi-agents-security-fix`
for the builder. `/harden` names them in the briefs. Evals run each case with the skill allowed
and denied, to see whether it helps.
