<!--
SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
SPDX-License-Identifier: Apache-2.0
-->

# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/); versions follow
[Semantic Versioning](https://semver.org/) as `MAJOR.MINOR.MICRO` without a `v` prefix.

## [Unreleased]

### Changed

- opencode 2 is tested on 2.0.29, the version in use now; 2.0.28 still works and now gets the
  installer's warning for an untested version.

### Fixed

- On opencode 2, the note opencode adds to continue a response that was cut off (interrupted,
  over the output limit, or stopped by a server restart) no longer counts as a new question
  from you: a task report is held back only while `lead` is still answering your own question.

## [0.5.3] - 2026-10-15

### Added

- npm package `@ecmwf.int/multi-agents`: `npm install -g @ecmwf.int/multi-agents`, then
  `ecmwf-multi-agents`, which runs the installer from the package with the same commands and
  options. Each release is published to npm from its tag by GitHub Actions, through npm
  trusted publishing and with provenance.
- Every push and pull request runs `make check` and `make pack-check` on GitHub Actions.
- Switch the harness on per project with one line in the project's `opencode.json`:
  `"plugins": ["@ecmwf.int/multi-agents@X.Y.Z"]`, or the path of a checkout such as
  `"{env:HOME}/.local/share/ecmwf-multi-agents"`. The plugin registers the agents, commands,
  skills and `lead` as the default agent in that project only; your own files and config still
  win.
- Problems with the settings files show as a warning in the opencode TUI.
- `install.sh doctor` asks opencode what it loaded: whether `lead` is there and from where,
  its review line, the default agent and the plugin's problems. `doctor --project` checks a
  project switched on by a `plugins` line, and `doctor` warns when an install in
  `~/.config/opencode/` masks a project's line.

### Changed

- The npm package's `./server` export names the opencode 2 plugin, and `./tui` its TUI entry.
- The plugin is a folder, `plugins/ecmwf-multi-agents/`, with `index.js` and `tui.js`; an
  install links the folder as a whole and removes the single-file plugin of earlier releases.
- The installer's unit tests no longer find an opencode installed in a system folder.

### Removed

- opencode 1.x is no longer supported; the harness supports opencode 2 only. With only
  opencode 1 installed, the installer stops and asks you to upgrade with
  `opencode upgrade --major`. Running `./install.sh` again replaces an install made for
  opencode 1, and `doctor` reports one until then.
- With it go the installer's `--platform` and `--central` options, the per-project plugin line
  for opencode 1.x, the background flag advice in the installer and `doctor`, `doctor`'s checks
  that started opencode 1.x, the files in `dist/opencode-v1/`, and the plugin parts that only
  opencode 1.x used: the shell guard after "Allow always", `/review` and `/progress` answering
  in your own session, the pinning of messages in a helper's session, and settings problems
  shown on screen.

## [0.5.2] - 2026-10-14

### Changed

- opencode 2 is tested on 2.0.28, the version in use now; it was 2.0.16, which still works and
  now gets the installer's warning for an untested version.
- On opencode 2.0.28, opencode no longer asks before any agent, the harness's included, reads
  or edits a file outside the project (opencode 1.x and 2.0.16 ask). The harness keeps that
  default.

## [0.5.1] - 2026-10-14

### Fixed

- `lead` answers your question before it acts on a task report that arrives while it is
  looking the answer up, on opencode 1.x and 2: the plugin holds such a report back until
  `lead` has answered, then delivers it. On opencode 2 a one-line message in the conversation
  then tells `lead` to act on the held reports. This was the known issue in 0.5.0.

## [0.5.0] - 2026-10-14

### Changed

- `/go` is now `/execute`: the name says what the command does. Type `/execute` where you
  typed `/go`; a project's own `/go`, if it has one, is no longer shadowed. After updating an
  installation, run `./install.sh` again: `git pull` alone leaves a broken `/go` link and does
  not add `/execute`. Projects switched on by a plugin line need nothing.
- `/execute` hands the ready tasks of a plan off in the background and ticks each as its report
  arrives, so parallel tasks overlap and you can keep talking to `lead` while they run; a
  plan whose tasks form a chain runs as before. On opencode 1.x this needs the background
  flag (`docs/install.md`).
- `/execute` asks before it carries on with a plan still in progress from another session,
  since that session's helpers may still be running.

### Fixed

- `/execute` checks its stop rules before it retries a failed task, so nothing new starts once
  a stop is due.

### Known issues

- While `/execute` runs tasks in the background, a question that `lead` has to look something
  up for can go unanswered when a task reports during the lookup: `lead` turns to the report
  instead. Ask again once the report is handled. A fix is planned for 0.5.1.

## [0.4.0] - 2026-10-13

### Added

- Switch the harness on per project without installing it (opencode 1.x). Keep one checkout,
  for example in `~/.local/share/ecmwf-multi-agents`, and add one line to the `opencode.json`
  of each project that should use it:
  `"plugin": ["{env:HOME}/.local/share/ecmwf-multi-agents"]`. The plugin then brings the
  agents, commands and skills from the checkout, and other projects stay as they were.
  Checking out a new version in the checkout updates every such project at its next start.
  `./install.sh --help` prints the line for your checkout, and
  `./install.sh doctor --project DIR` checks such a project. See `docs/install.md`.

## [0.3.0] - 2026-10-13

### Added

- Helpers can run in the background. When `lead` has other work meanwhile, or you may want
  to keep talking, it hands off in the background and the helper's report arrives later in
  your conversation. On opencode 1.x this needs `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true`
  in your environment before opencode starts; the installer prints the line and
  `./install.sh doctor` checks it. Without it `lead` waits for every helper, as before.
- `lead` can see, redirect and stop its helpers: three plugin tools, `helpers_status`,
  `helpers_steer` and `helpers_cancel`. A redirected helper keeps everything it has read and
  done and follows the amendment at its next step instead of starting over. Tell
  `lead` "redirect the scout: stay in src/" or "stop the builder". Helpers cannot use these
  tools, whatever was approved.
- On opencode 1.x, typing into a running helper's own session now steers that helper. Before,
  the message switched the rest of its run to `lead`'s prompt, permissions and model.
- Eval cases `background-scouts`, `steer`, `restart` (the same change of scope as `steer`,
  done by stopping the scout and starting a new one, for comparison), `cancel`, and
  `review-background` (`/review` while a background scout works).

### Changed

- Prompt budgets are ceilings raised only to a measured change: `lead` 2,050 tokens, helpers
  750, skills 1,450, for the background rules and the guide to them.

### Fixed

- On opencode 1.x, `/review` or `/progress` sent while `lead` is working (for example
  `/progress` during a long `/go`) no longer takes over `lead`'s turn. It runs separately, and
  `lead` then carries on with the report in view. Sent while `lead` is idle, it still answers
  directly in your conversation.
- On opencode 1.x, a background helper that finishes after `/review` or `/progress` now wakes
  `lead` instead of the reviewer or scout; one that finishes during a review waits for the
  verdict first.

## [0.2.0] - 2026-10-11

### Changed

- `/review` and `/progress` cost less on opencode 1.x: a quarter to a third of what they did
  in a new session, and about half after some conversation. The reviewer or scout now answers
  in your own session, so its report appears there directly and `lead` no longer spends a turn
  relaying it; the plugin keeps the earlier conversation out of the helper's requests, so
  reviews stay independent and cheap in long sessions. On opencode 2 they still run in a
  separate session, and `lead` relays the report briefly.
- Releasing is one command: `make release X.Y.Z` runs the checks, sets the version, updates
  the changelog and `dist/`, commits, pushes, tags and publishes, and continues where it
  stopped when run again. `make version` now only prints the version.

### Fixed

- `lead` runs each command that needs your approval (push, pull requests, merges, history
  rewrites) on its own. It used to chain a commit and a push in one command, so refusing the
  push also lost the commit.

### Added

- `evals/results/` keeps eval summaries for comparison; the first one is the 0.1.0 baseline.
- Eval cases `review-warm` and `progress-warm` run the commands after a first question, as in
  normal use.

## [0.1.0] - 2026-10-11

The first release: a multi-agent harness for opencode with one agent you talk to and three
helpers it hands work to.

### Added

- Four agents. `lead` talks to you, plans, hands out work, checks results and commits when
  asked. `scout` does read-only lookups and investigations, `builder` makes one specified
  change and runs its checks, and `reviewer` gives an independent APPROVE or REJECT. Helpers
  work from a written brief, report in a fixed format, never ask you questions and never hand
  work on.
- Default models and efforts: `lead` Claude Opus 5.5 at xhigh, `scout` Claude Sonnet 5.5 at
  medium, `builder` Claude Sonnet 5.5 at high, `reviewer` GPT 6.1 Sol through GitHub Copilot at
  medium. Profiles `default`, `anthropic`, `copilot` and `inherit`.
- Commands: `/onboard` surveys a repository and keeps a summary for later sessions, `/plan`
  plans work with you and waits for approval, `/go` carries out an approved plan (also in a
  fresh session), `/review` reviews uncommitted changes, a branch, a commit, a pull request or
  a plan (it replaces opencode's own `/review`), `/progress` shows plan progress, and `/guide`
  explains the harness.
- A settings file, `ecmwf-multi-agents.jsonc`, globally and per project: the review policy
  (`auto`, `ask`, `always`, `never`), the profile, whether `lead` is the default agent, and
  per-agent `model`, `effort` and `steps`. A small plugin applies it when opencode starts.
- Safety rules: helpers cannot commit, push or rewrite history; pushing, pull requests and
  merges always need your approval. On opencode 1.x the plugin keeps the helpers' limits even
  after an "Allow always" answer.
- `install.sh`: install for yourself (links), for one project (copies), or once on a shared
  machine for opencode 1.x (a read-only copy loaded with `OPENCODE_CONFIG_DIR`); `doctor`
  checks an installation and `uninstall` removes it. It never overwrites files it did not
  create.
- Support for opencode 1.x from 1.18.35 (tested on 1.18.35 and 1.19.0) and for opencode 2.0.16.
- Scenario evals (`make evals`) that compare the harness with plain opencode on a sample
  repository, using real models.

[Unreleased]: https://github.com/ecmwf/ecmwf-multi-agents/compare/0.5.3...HEAD
[0.5.3]: https://github.com/ecmwf/ecmwf-multi-agents/compare/0.5.2...0.5.3
[0.5.2]: https://github.com/ecmwf/ecmwf-multi-agents/compare/0.5.1...0.5.2
[0.5.1]: https://github.com/ecmwf/ecmwf-multi-agents/compare/0.5.0...0.5.1
[0.5.0]: https://github.com/ecmwf/ecmwf-multi-agents/compare/0.4.0...0.5.0
[0.4.0]: https://github.com/ecmwf/ecmwf-multi-agents/compare/0.3.0...0.4.0
[0.3.0]: https://github.com/ecmwf/ecmwf-multi-agents/compare/0.2.0...0.3.0
[0.2.0]: https://github.com/ecmwf/ecmwf-multi-agents/compare/0.1.0...0.2.0
[0.1.0]: https://github.com/ecmwf/ecmwf-multi-agents/releases/tag/0.1.0
