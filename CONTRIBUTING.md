<!--
SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
SPDX-License-Identifier: Apache-2.0
-->

# Contributing

This page is for people who work on ecmwf-multi-agents itself. To use the harness, see the
[README](README.md). The design is in [`DESIGN.md`](DESIGN.md); the rules for people and agents
working here are in [`AGENTS.md`](AGENTS.md).

## Install from source

Clone the repository anywhere and run the installer. It links the agents, commands, skills and
plugin into `~/.config/opencode/` and writes a settings file; it never overwrites files it did
not create.

```sh
git clone https://github.com/ecmwf/ecmwf-multi-agents.git ~/.local/share/ecmwf-multi-agents
cd ~/.local/share/ecmwf-multi-agents
./install.sh
```

Restart opencode afterwards. To update, run `git pull` and `./install.sh` again, then restart
opencode. To stay on a release, check out its tag (for example `git checkout 0.11.0`) before
running the installer. `./install.sh --project /path/to/repo` installs into one project only;
`./install.sh doctor` checks the setup and `./install.sh uninstall` removes it.

A project can also name the checkout in its `opencode.json` instead of the npm package
(`{env:HOME}` is your home folder; `~` does not work here), and `git pull` updates it:

```json
{
  "plugins": ["{env:HOME}/.local/share/ecmwf-multi-agents"]
}
```

Use one way of installing at a time; `doctor` warns when two copies are loaded.
[`docs/install.md`](docs/install.md) covers every option, central installs on shared machines,
and troubleshooting.

## Build and test

With [Bun](https://bun.sh), `reuse` and `shellcheck` installed:

```sh
make setup      # install the development dependencies
make build      # regenerate dist/ from src/
make check      # the gate before every commit: versions, dist/, lint, unit tests
make help       # every target
```

Edit harness content only in `src/`, then run `make build` and commit the regenerated `dist/`
with the change. `make integration` runs the suites against a real opencode 2 without calling a
model. `make evals` runs scenario evals with real models and uses your provider quota; see
[`evals/README.md`](evals/README.md).

## Work together

Open work, proposals and questions are
[GitHub issues](https://github.com/ecmwf/ecmwf-multi-agents/issues), labelled `task`,
`proposal` or `question`, with a topic label.

- Take a `task` by assigning yourself to its issue, before you start. An issue assigned to
  someone else is theirs.
- A `proposal` is not approved: discuss it on the issue before any work.
- `main` takes changes only through pull requests. Work on a branch and say in the pull request
  which issue it closes (`Closes #12`).
- Commits follow Conventional Commits. Record user-visible changes under `## [Unreleased]` in
  `CHANGELOG.md`.

## Release

Versions are `MAJOR.MINOR.MICRO` without a `v`. Because `main` takes changes only through pull
requests, a release goes in two steps:

1. On a branch `release/X.Y.Z` that holds `main`, run `make release X.Y.Z`. It checks the files
   npm would publish, runs the gate, sets the version, moves the `[Unreleased]` entries under
   it, rebuilds `dist/`, runs the gate again, commits `chore: release X.Y.Z` and pushes the
   branch. Open a pull request into `main`.
2. Once it is merged, run `make release X.Y.Z` on `main`. It tags the release commit and
   publishes the GitHub release; the tag publishes the npm package through
   `.github/workflows/release.yml`.

`DRY_RUN=1` previews either step. After a failure, fix the cause and run the same command again:
it continues where it stopped.
