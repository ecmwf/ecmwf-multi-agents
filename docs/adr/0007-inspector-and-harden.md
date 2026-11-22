<!--
SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
SPDX-License-Identifier: Apache-2.0
-->

# 0007. The inspector and /harden

Status: Accepted. Date: 2026-11-22.

## Context

Users asked for a dedicated security review: a helper that looks at code only for weaknesses,
the ways an attacker could reach in and the surface that could be made smaller, and that
advises rather than changes, because each hardening step has a cost people must weigh. The
reviewer checks a change against its goal; it does not map a project's attack surface. The
tester breaks code with unlucky input, not with hostile intent. ADR 0005 sets the rules for an
optional helper.

## Decisions

- A new optional helper, `inspector`, off by default like the other specialists (ADR 0005).
  It reviews code for security weaknesses and gives each finding a severity, a confidence, the
  advice, its pros and cons, and the alternatives. People decide on every change.
- It reads code and runs local scanners under the user's shell policy, installed or in a
  throwaway environment (`uvx pip-audit`, `npx osv-scanner`, `semgrep`, `gitleaks`). It writes
  only `.ecmwf-multi-agents/security/`. Git and `gh` writes, GitHub and the web are denied: web
  pages and alerts are untrusted input, so `lead` has a scout read advisories and CVEs and
  passes them on, and reads GitHub's alerts itself with the user's approval.
- Its model differs from the builder's and from `lead`'s where the profile allows, as for the
  reviewer: `github-copilot/gpt-6.2-astra` at xhigh in the default profile, falling back to
  Claude Opus 5.5 at xhigh without Copilot; Opus 5.5 xhigh in `anthropic`, Astra in `copilot`.
- `lead` hands work to it only when the user asks for a security review or runs `/harden`.
- `/harden [target]` runs on `lead`: the inspector reviews, the user picks findings in one
  question, and for each pick builder fixes and reviewer checks, at most two rounds. Each fix is
  one commit, `fix(security): ...`, on the current branch; running the command asks for these
  commits, and nothing is pushed. The inspector then rechecks each pick: CLOSED, OPEN or PARTLY.
- On GitHub, `lead` asks before it reads the open code scanning, Dependabot and secret scanning
  alerts, and offers to start a CodeQL workflow; `gh workflow run` always asks.
- Three hidden skills of the harness's own, inspired by cybersecurity-skills (MIT) but not
  copied (`docs/research/security-skills.md`): `ecmwf-multi-agents-security-code` and
  `ecmwf-multi-agents-security-supply-chain`, checklists for the inspector, and
  `ecmwf-multi-agents-security-fix`, safe-fix rules for the builder and recheck verdicts for the
  inspector. Each checklist item has an ID that findings cite. `/harden` names them in its
  briefs, so they cost nothing in the helpers' prompts; narrow allow rules let only these two
  helpers load them. Evals run each skill's case with the skills allowed and denied.
- A command may name the helper it needs (`needs` in the manifest). While that helper is off,
  the plugin's command refuses with the settings line that switches it on, and no model turn
  starts, as `/review` does with the reviewer off.

## Consequences

- One more line in `lead`'s helper list while the inspector is on: `lead-all` is 2450.
- A security review costs a strong model at high effort, so it runs only on request.
- Findings are advice, not a guarantee: the recheck says what the inspector could show is
  closed, not that the code is secure.
