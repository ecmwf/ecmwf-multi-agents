<!--
SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
SPDX-License-Identifier: Apache-2.0
-->

# Scenario evals

The evals run typical requests through the harness and through plain opencode, and compare the
two. They answer three questions:

- Does the harness finish typical tasks? Each case has checks: hidden tests, facts the answer
  must state, files that may or may not change, the reviewer's verdict, the state of a plan.
- Is its routing economical? Each run records cost and tokens per agent, the child sessions
  each helper ran, and the peak context of the agent that talks to the user.
- Do its safety rules hold? The `no-push` case asks for a push, refuses the approval, and checks
  that nothing reached the remote and that no agent tried another way.

The baseline is plain opencode with its built-in `build` agent on lead's model and effort from
the same profile, with no harness installed.

The evals call real models and use your provider quota. A full run of every case on both
variants costs real money; `--max-cost` stops starting new runs once the total reaches the
limit (40 US dollars by default).

## Running

`make evals` runs every case on both variants. To choose, call the runner directly:

```sh
bun evals/run.ts --list                       # the cases, one per line
bun evals/run.ts --case answer --variant harness
bun evals/run.ts --case feature --case bug-fix --repeat 3 --jobs 3
```

| Option | Default | Meaning |
|---|---|---|
| `--case ID` | all cases | Run this case; repeat the option for several |
| `--repeat N` | 1 | Runs per case and variant |
| `--variant V` | `both` | `harness`, `baseline` or `both` |
| `--profile NAME` | `default` | Harness profile from `dist/opencode-v1/ecmwf-multi-agents/profiles/`; the baseline uses its lead model |
| `--jobs N` | 2 | Runs at the same time |
| `--max-cost USD` | 40 | Start no new run once the total cost reaches this; runs already started finish |
| `--timeout MIN` | 20 | Time limit for each turn; a turn that runs over is stopped and the run counts as timed out |
| `--opencode BIN` | `opencode` | The opencode 1.x binary |
| `--out DIR` | `evals/runs/<UTC timestamp>/` | Output folder (`evals/runs/` is ignored by git) |
| `--list` | | List the cases and exit |

Requirements: opencode 1.x (tested with 1.18.35), Bun, git, `python3`, and a built `dist/`
(`bun run build`). The first opencode start in each sandbox installs the plugin's one
dependency from npm, so network access is needed.

## Isolation and credentials

Every run gets a fresh sandbox folder under the system temporary directory (`$TMPDIR`). Every
opencode command runs through `tools/sandbox.sh`, so `HOME` and the XDG folders point into the
sandbox and your own opencode configuration, data and sessions are never read or changed. The
project is a git repository created in the sandbox from `evals/fixtures/stations/`, with a
fixed author, committer and dates, so its commits are the same in every run.

- Harness: `install.sh` installs the harness into the sandbox (global, linked, with the case's
  review policy and the chosen profile).
- Baseline: no harness; the sandbox `opencode.json` sets the `build` agent to lead's model and
  effort.
- Both: `enabled_providers` lists only the providers the profile uses, lead's model is the
  session model, and sharing is off.

Your opencode login is reached through a symbolic link: the sandbox's
`home/.local/share/opencode/auth.json` points at `$ECMWF_MULTI_AGENTS_EVAL_AUTH`, or at
`~/.local/share/opencode/auth.json` when that variable is unset. The runner never reads,
copies or prints the file; opencode reads it through the link, and token refreshes write
through it as in your own setup. If the file is missing, the runner stops before any run.

The sandbox never loads your own opencode configuration, so plugins you use to log in to a
provider are missing there. When a provider's login needs one (an OAuth login, for example),
name it in `ECMWF_MULTI_AGENTS_EVAL_PLUGINS`, separated by spaces or commas; the runner adds
those names to the sandbox's `plugin` list. Each run checks first that the sandbox can use every
model of the profile, and the runner stops with a message naming the provider when it cannot.

opencode and the commands it runs get only a short list of environment variables (`PATH`,
locale, terminal, shell, user and `TMPDIR`) plus the git identity, so other variables of your
session cannot end up in a transcript. The sandbox is deleted after each run, the link
included; the file it points to stays.

## Answering on your behalf

The runner plays the user. It approves permission requests once, except pushes, pull requests,
merges and history rewrites, which it refuses. It answers questions with the first option,
which the harness prompts mark as the recommended one. In `plan-execute` it approves the plan with
"Approved. Go ahead." and, if lead does not finish the plan in the same session, runs `/execute` in a
new session.

## Cases

| Case | What it asks | Baseline |
|---|---|---|
| `answer` | A factual question answered from one or two files | yes |
| `trivial-edit` | Change one default value | yes |
| `bug-fix` | Fix a seeded bug described by its symptom | yes |
| `feature` | `summary --json` across modules, review policy `auto` | yes |
| `investigate` | Why a count is low: three causes in three modules | yes |
| `inventory` | Every public function with its module and purpose | yes |
| `review-reject` | `/review` of an uncommitted change with a real bug | no |
| `review-approve` | `/review` of an uncommitted correct change | no |
| `no-push` | Commit and push to a local bare remote; the push is refused | yes |
| `onboard` | `/onboard` writes the summary and changes nothing else | no |
| `plan-execute` | `/plan`, approval, the plan carried out | no |
| `execute-chat` | `/execute` on a seeded plan with two tasks ready; a question while they run, answered by `lead` before the next completion | no |
| `progress` | `/progress` on a seeded plan | no |
| `review-warm`, `progress-warm` | The two commands after a first question, in a session with history | no |
| `background-scouts` | Two questions handed to scouts in the background while the user keeps talking | no |
| `steer`, `restart` | A change of scope for a running scout: redirected with `helpers_steer`, or stopped and started again | no |
| `cancel` | A running builder stopped with `helpers_cancel` | no |
| `review-background` | A background scout, then `/review` on a seeded bug; every completion answered by `lead` | no |

The cases are defined in `evals/cases.ts`; hidden tests are in `evals/hidden/<case>/` (a case
may name another case's folder) and run from outside the project after the run. In `no-push`, the baseline has no approval rule, so its
safety checks are recorded but do not decide whether the run passes.

## Output

Each run writes `<case>.<variant>.<n>.json` with the turns and final answers, every permission
request and the reply given, every question and the answer given, metrics, the changed files and
the project diff, the check results, and a transcript of every session (long tool output
shortened). Metrics come from the messages of every session of the run: cost and tokens (input,
output, reasoning, cache read and write) in total and per agent, models per agent, child
sessions per agent, model requests, tool calls, refused tool calls and shell commands per agent,
and the largest context of one request by the agent that talks to the user.

`summary.md` has a section per case, then totals per variant and the comparison.

Run folders are not committed. Summaries worth keeping for comparison go in `evals/results/`,
named after the release they measured, with the licence header added (for example
`evals/results/0.1.0.md`).

## Reading the summary

- Result: a run passes when it finished in time and every counted check passed. A check shown
  in brackets is recorded only and does not decide the result.
- Cost: what opencode reports for each model request. Requests through GitHub Copilot count
  against the subscription; opencode reports their cost only when Copilot sends it.
- Cost per agent and child sessions: where the money went and which helpers ran.
- Peak context: the largest input of one request by lead (or by `build` for the baseline),
  cached tokens included. It shows how much the main conversation had to carry.
- Harness versus baseline: pass counts and means per run. A cost ratio below 1 means the
  harness was cheaper for that case.

Results vary between runs of the same case, so compare with `--repeat 3` or more before drawing
conclusions.

## Tests

```sh
bun test evals                                        # fast unit tests, no network
ECMWF_MULTI_AGENTS_INTEGRATION=1 bun test evals/run.integration.test.ts
```

The unit tests need git and `python3`: they apply every case's setup to the fixture and check
that its hidden tests fail before the work is done. The second command runs the runner end to end with real `install.sh`, `dist/` and opencode, but with a
local stand-in model server instead of real models: a question answered by policy, a scout, a
refused push, `/review`, a baseline run and a time-out.
