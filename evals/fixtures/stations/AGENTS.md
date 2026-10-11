<!--
SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
SPDX-License-Identifier: Apache-2.0
-->

# Notes for coding agents

- Standard library only; Python 3.10 or later. Do not add dependencies.
- Run the tests with `python3 -m unittest` from the repository root. pytest is not installed.
- Temperatures are stored in degrees Celsius and converted only for output.
- Keep the command-line output format stable: other tools parse it.
- Commit messages follow Conventional Commits, for example `fix: handle empty files`.
