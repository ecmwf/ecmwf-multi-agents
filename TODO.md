<!--
SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
SPDX-License-Identifier: Apache-2.0
-->

# TODO

Proposals and deferred work. Nothing here is approved for implementation until its status
says so. Approved work moves to `PLAN.md`.

## Job-specific support

The first release keeps every role generic. Each item below would add tailored support for
one kind of job: a routing rule for `lead`, a slash command, skills, permission defaults and
eval cases. Jobs without tailored support still work through the general flow; they are just
not tuned or tested for.

### Change code in a repository

Status: not approved.

Plan, approve, build, verify and review for features, fixes, refactors and tests. Skills for
ecbuild and CMake, and for Python, Fortran and C++ conventions. Evals on real repository tasks
with tests.

### Understand and explain code

Status: not approved.

Read-only explanations pitched at scientists and analysts, including Fortran and IFS code
archaeology and call-graph tracing. An `/explain` command. Evals on explanation accuracy.

### Data work

Status: not approved.

Retrieve, process and plot data (MARS, CDS, open data, Polytope, earthkit) with reproducible
scripts and recorded provenance. Reuse the skills from ecmwf-weather-skills. Evals on correct
data and figures.

### HPC and workflows

Status: not approved.

Atos and Slurm job scripts, modules, ecFlow suites. Skills plus permission defaults, such as
asking before `sbatch` or any job submission. Evals on script and suite correctness.

### Review and PR preparation

Status: not approved.

Independent diff review; commit and PR text in the house style (Conventional Commits, no AI
attribution, no process history). Commands for review and PR text.

### Docs and writing

Status: not approved.

READMEs, mdBook and Sphinx docs, technical notes in the house style (plain prose, no em
dashes, mermaid diagrams).

## Model profiles

### ECMWF internal model endpoint

Status: deferred.

A profile for ECMWF's internal OpenAI-compatible model service, for users without commercial
providers. Revisit when the service is ready for regular use. The work: the profile, eval runs
on it, and prompt tuning for a mid-size model leading the session.

### OpenAI direct

Status: not approved.

An `openai` profile needs a tier mapping across the gpt-6.x family (which model suits
scouting, building and reviewing) backed by eval numbers.
