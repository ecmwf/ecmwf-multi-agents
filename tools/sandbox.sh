#!/bin/sh
# SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
#
# SPDX-License-Identifier: Apache-2.0

# Run a command with HOME and the XDG directories inside a sandbox directory, so opencode
# never reads or writes the real user configuration, data, state or sessions. Variables that
# an enclosing opencode session sets are removed.
#
# opencode 2 also reads project config (opencode.json, opencode.jsonc, .opencode, .claude,
# .agents) from every folder above the project, up to the file system root; a git repository
# does not stop that search (core/src/config/discovery.ts at v2.0.29). This script cannot
# switch it off for a project that needs its own config, so callers check the folders above
# DIR themselves (the eval runner refuses to start when one holds such a file). The two
# OPENCODE_DISABLE_* variables below were read by opencode 1.x; 2.0.29 ignores them.
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
