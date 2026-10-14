#!/bin/sh
# SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
#
# SPDX-License-Identifier: Apache-2.0

# Run a command with HOME and the XDG directories inside a sandbox directory, so opencode
# never reads or writes the real user configuration, data, state or sessions. Variables that
# an enclosing opencode session sets are removed.
#
# opencode also looks for project config and skill folders in parent directories, up to the
# file system root when a project is outside git. Skill folders of other tools (.claude,
# .agents) are switched off here; create test projects with `git init` so the search for
# project config stops at the project root.
#
# Usage: tools/sandbox.sh DIR command [args...]
#   DIR is created if missing and reused if present, so several commands can share a sandbox.
#   The sandbox config directory is DIR/home/.config/opencode.

set -eu

if [ "$#" -lt 2 ]; then
	echo "usage: $0 DIR command [args...]" >&2
	exit 2
fi

dir=$1
shift
mkdir -p "$dir/home/.config" "$dir/home/.local/share" "$dir/home/.local/state" "$dir/home/.cache"
home=$(cd "$dir/home" && pwd)

# OPENCODE_SERVER_USERNAME and OPENCODE_SERVER_PASSWORD would make a sandboxed server demand
# the enclosing session's basic auth, so every unauthenticated test request would get 401.
exec env \
	-u OPENCODE -u OPENCODE_PID -u AGENT \
	-u OPENCODE_CONFIG -u OPENCODE_CONFIG_DIR -u OPENCODE_CONFIG_CONTENT \
	-u OPENCODE_SERVER_USERNAME -u OPENCODE_SERVER_PASSWORD \
	-u XDG_CONFIG_DIRS \
	HOME="$home" \
	XDG_CONFIG_HOME="$home/.config" \
	XDG_DATA_HOME="$home/.local/share" \
	XDG_STATE_HOME="$home/.local/state" \
	XDG_CACHE_HOME="$home/.cache" \
	OPENCODE_DISABLE_AUTOUPDATE=1 \
	OPENCODE_DISABLE_EXTERNAL_SKILLS=1 \
	OPENCODE_DISABLE_CLAUDE_CODE=1 \
	"$@"
