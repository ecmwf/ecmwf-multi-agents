#!/bin/sh
# SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
#
# SPDX-License-Identifier: Apache-2.0

# Install, check or remove the ecmwf-multi-agents harness for opencode.
# Run "./install.sh --help" for usage. Needs only standard tools (sed, grep, awk, cmp, ln, cp,
# readlink); jq is used by doctor when it is installed.

set -eu

NAME=ecmwf-multi-agents
NPM_NAME=@ecmwf.int/multi-agents
MARKER_MD="# managed by $NAME"
MARKER_JS="// managed by $NAME"
V2_PINNED=2.0.29
# The plugin is a folder. opencode loads it only when its entry's real path lies inside it, so in
# link mode the folder itself is the link. Earlier releases installed one file instead.
PLUGIN_REL=plugins/$NAME
LEGACY_PLUGIN=plugins/$NAME.js

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)

# The command the user ran, for messages: the npm package's command sets it, otherwise the path
# this script was run by.
case $0 in
*/*) PROG=$0 ;;
*) PROG="sh $0" ;;
esac
PROG=${ECMWF_MULTI_AGENTS_COMMAND:-$PROG}

say() { printf '%s\n' "$*"; }
warn() { printf 'Warning: %s\n' "$*" >&2; }
die() {
	printf 'Error: %s\n' "$*" >&2
	exit 1
}

usage() {
	cat <<EOF
Usage: $PROG [command] [options]

Commands:
  install     Install or update the harness (the default).
  doctor      Check an installation and explain any problem found.
  uninstall   Remove the harness files. Your settings file stays unless you add --purge.

Where (default: your own opencode config folder, ~/.config/opencode):
  --project DIR     Install for one project only, into DIR/.opencode (files are copied).

Options:
  --profile NAME    Which models the agents use: default, anthropic, copilot or inherit.
  --review WHEN     When the reviewer checks work: auto, ask, always or never.
  --link, --copy    Link the files to this checkout (they update with git pull) or copy them.
  --dry-run         Show what would happen, change nothing.
  --purge           With uninstall: also remove the settings file.
  -h, --help        Show this help.

Examples:
  $PROG
  $PROG --profile anthropic --review always
  $PROG --project ~/code/my-repo
  $PROG doctor
  $PROG doctor --project ~/code/my-repo

A project can also switch the harness on without installing files, with one line in its
opencode.json: "plugins": ["@ecmwf.int/multi-agents@VERSION"] or the path of a checkout.

The harness needs opencode 2.
EOF
}

# ---------------------------------------------------------------- options

COMMAND=install
case ${1-} in
install | doctor | uninstall)
	COMMAND=$1
	shift
	;;
esac

PROJECT=
PROFILE_OPT=
REVIEW_OPT=
MODE_OPT=
DRY_RUN=0
PURGE=0

need_value() {
	[ -n "${2-}" ] || die "$1 needs a value (see $PROG --help)"
}

while [ "$#" -gt 0 ]; do
	case $1 in
	--project)
		need_value "$@"
		PROJECT=$2
		shift 2
		;;
	--project=*)
		PROJECT=${1#*=}
		shift
		;;
	--profile)
		need_value "$@"
		PROFILE_OPT=$2
		shift 2
		;;
	--profile=*)
		PROFILE_OPT=${1#*=}
		shift
		;;
	--review)
		need_value "$@"
		REVIEW_OPT=$2
		shift 2
		;;
	--review=*)
		REVIEW_OPT=${1#*=}
		shift
		;;
	--link)
		MODE_OPT='link'
		shift
		;;
	--copy)
		MODE_OPT=copy
		shift
		;;
	--dry-run)
		DRY_RUN=1
		shift
		;;
	--purge)
		PURGE=1
		shift
		;;
	-h | --help)
		usage
		exit 0
		;;
	*) die "unknown option: $1 (see $PROG --help)" ;;
	esac
done

case $REVIEW_OPT in '' | auto | ask | always | never) ;; *) die "--review must be auto, ask, always or never" ;; esac
[ "$PURGE" = 0 ] || [ "$COMMAND" = uninstall ] || die "--purge only works with uninstall"

DIST_ROOT=${ECMWF_MULTI_AGENTS_DIST:-$SCRIPT_DIR/dist}
if [ -d "$DIST_ROOT" ]; then
	DIST_ROOT=$(CDPATH='' cd -- "$DIST_ROOT" && pwd -P)
fi

GLOBAL_DIR=${XDG_CONFIG_HOME:-${HOME:?HOME is not set}/.config}/opencode
if [ -n "$PROJECT" ]; then
	[ -d "$PROJECT" ] || die "project folder not found: $PROJECT"
	PROJECT=$(CDPATH='' cd -- "$PROJECT" && pwd -P)
	CONFIG_DIR=$PROJECT/.opencode
	TARGET=project
else
	CONFIG_DIR=$GLOBAL_DIR
	TARGET=global
fi
RECORD=$CONFIG_DIR/$NAME/installed.txt
SETTINGS=$CONFIG_DIR/$NAME.jsonc

# ---------------------------------------------------------------- opencode versions

# The harness files are for opencode 2. Since 2.0.0 its command is "opencode", with the alias
# "opencode2"; an older opencode is only named, to say it needs an upgrade.
PLATFORM=v2
OPENCODE_BIN=
V2_VERSION=
OLD_VERSION=

version_of() {
	"$1" --version 2>/dev/null | sed -n 's/^[^0-9]*\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\).*$/\1/p' | sed -n '1p'
}

detect_versions() {
	for detect_bin in opencode opencode2; do
		command -v "$detect_bin" >/dev/null 2>&1 || continue
		detect_version=$(version_of "$detect_bin" || true)
		case $detect_version in
		2.*)
			if [ -z "$V2_VERSION" ]; then
				V2_VERSION=$detect_version
				OPENCODE_BIN=$detect_bin
			fi
			;;
		?*) [ -n "$OLD_VERSION" ] || OLD_VERSION=$detect_version ;;
		esac
	done
}

UPGRADE_ADVICE="this harness needs opencode 2: upgrade with \"opencode upgrade --major\""

require_opencode2() {
	detect_versions
	if [ -z "$V2_VERSION" ]; then
		if [ -n "$OLD_VERSION" ]; then
			die "opencode $OLD_VERSION was found, but $UPGRADE_ADVICE, then run this again."
		fi
		die "opencode was not found. Install opencode 2 first (see https://opencode.ai), then run this again."
	fi
	if [ "$V2_VERSION" != "$V2_PINNED" ]; then
		warn "opencode $V2_VERSION found; this harness is tested with opencode $V2_PINNED."
	fi
}

# ---------------------------------------------------------------- ownership

valid_rel() {
	case $1 in
	'' | /* | *..* | *[!A-Za-z0-9._/-]*) return 1 ;;
	esac
	return 0
}

# A link is ours when it points into this checkout's dist folder, or at the same file in
# another copy of the harness. opencode-v1 links come from installs for opencode 1, so that
# running this again replaces them.
link_is_ours() {
	link_dest=$(readlink "$1" 2>/dev/null) || return 1
	case $link_dest in
	"$DIST_ROOT"/* | */opencode-v1/"$2" | */opencode-v2/"$2") return 0 ;;
	esac
	return 1
}

file_is_marked() {
	[ -f "$1" ] || return 1
	case $2 in
	*.md) sed -n '1,6p' "$1" | grep -qxF -- "$MARKER_MD" ;;
	*.js) sed -n '1p' "$1" | grep -qxF -- "$MARKER_JS" ;;
	*) return 1 ;;
	esac
}

# True when the file at $1 (installed path $2) belongs to the harness and may be replaced.
is_ours() {
	if [ -L "$1" ]; then
		link_is_ours "$1" "$2"
		return
	fi
	[ -e "$1" ] || return 1
	case $2 in
	"$NAME"/*) [ -f "$1" ] && return 0 ;;
	esac
	file_is_marked "$1" "$2"
}

# Remove directories left empty, from $1 up to (not including) the config folder.
prune_dirs() {
	prune_dir=$1
	while [ "$prune_dir" != "$CONFIG_DIR" ]; do
		case $prune_dir in "$CONFIG_DIR"/*) ;; *) return 0 ;; esac
		rmdir -- "$prune_dir" 2>/dev/null || return 0
		prune_dir=$(dirname -- "$prune_dir")
	done
}

recorded_files() {
	sed -n 's/^file=//p' "$RECORD"
}

recorded_value() {
	sed -n "s/^$1=//p" "$RECORD" | sed -n '1p'
}

# ---------------------------------------------------------------- install

ADDED=0
UPDATED=0
UNCHANGED=0
REMOVED=0
CONFLICTS=
NEW_LIST=

cleanup() {
	[ -z "$NEW_LIST" ] || rm -f -- "$NEW_LIST"
}

place_file() {
	place_src=$SRC_DIR/$1
	place_dst=$CONFIG_DIR/$1
	if [ ! -f "$place_src" ]; then
		die "the checkout is incomplete: $place_src is missing. Run git pull, or rebuild with bun run build."
	fi
	if [ -L "$place_dst" ] || [ -e "$place_dst" ]; then
		if ! is_ours "$place_dst" "$1"; then
			CONFLICTS="$CONFLICTS
  $place_dst"
			return 0
		fi
		if [ "$MODE" = link ] && [ -L "$place_dst" ] && [ "$(readlink "$place_dst")" = "$place_src" ]; then
			UNCHANGED=$((UNCHANGED + 1))
			say "$1" >>"$NEW_LIST"
			return 0
		fi
		if [ "$MODE" = copy ] && [ ! -L "$place_dst" ] && cmp -s -- "$place_src" "$place_dst"; then
			UNCHANGED=$((UNCHANGED + 1))
			say "$1" >>"$NEW_LIST"
			return 0
		fi
		UPDATED=$((UPDATED + 1))
		place_action=update
	else
		ADDED=$((ADDED + 1))
		place_action=add
	fi
	say "$1" >>"$NEW_LIST"
	if [ "$DRY_RUN" = 1 ]; then
		say "  would $place_action $place_dst"
		return 0
	fi
	mkdir -p -- "$(dirname -- "$place_dst")"
	rm -f -- "$place_dst"
	if [ "$MODE" = link ]; then
		ln -s -- "$place_src" "$place_dst"
	else
		cp -- "$place_src" "$place_dst"
	fi
}

# The plugin folder in link mode: one link to the folder in this checkout. Decided once, then
# counted for each of its files.
PLUGIN_ACTION=
PLUGIN_UNLINKED=0

plugin_dir_is_ours() {
	for plugin_entry in "$1"/* "$1"/.[!.]*; do
		[ -e "$plugin_entry" ] || [ -L "$plugin_entry" ] || continue
		is_ours "$plugin_entry" "$PLUGIN_REL/${plugin_entry##*/}" || return 1
	done
	return 0
}

link_plugin_dir() {
	plugin_src=$SRC_DIR/$PLUGIN_REL
	plugin_dst=$CONFIG_DIR/$PLUGIN_REL
	if [ -L "$plugin_dst" ]; then
		if [ "$(readlink "$plugin_dst")" = "$plugin_src" ]; then
			PLUGIN_ACTION=unchanged
			return 0
		fi
		link_is_ours "$plugin_dst" "$PLUGIN_REL" || PLUGIN_ACTION=conflict
	elif [ -d "$plugin_dst" ]; then
		plugin_dir_is_ours "$plugin_dst" || PLUGIN_ACTION=conflict
	elif [ -e "$plugin_dst" ]; then
		PLUGIN_ACTION=conflict
	fi
	if [ "$PLUGIN_ACTION" = conflict ]; then
		CONFLICTS="$CONFLICTS
  $plugin_dst"
		return 0
	fi
	if [ -L "$plugin_dst" ] || [ -e "$plugin_dst" ]; then PLUGIN_ACTION=update; else PLUGIN_ACTION=add; fi
	if [ "$DRY_RUN" = 1 ]; then
		say "  would $PLUGIN_ACTION $plugin_dst (a link to the folder)"
		return 0
	fi
	mkdir -p -- "$(dirname -- "$plugin_dst")"
	if [ -L "$plugin_dst" ]; then
		rm -f -- "$plugin_dst"
	elif [ -d "$plugin_dst" ]; then
		rm -rf -- "$plugin_dst"
	fi
	ln -s -- "$plugin_src" "$plugin_dst"
}

# In copy mode the folder must be a real folder: replace a link to it from a link install.
unlink_plugin_dir() {
	plugin_dst=$CONFIG_DIR/$PLUGIN_REL
	[ -L "$plugin_dst" ] || return 0
	if ! link_is_ours "$plugin_dst" "$PLUGIN_REL"; then
		PLUGIN_ACTION=conflict
		CONFLICTS="$CONFLICTS
  $plugin_dst"
		return 0
	fi
	if [ "$DRY_RUN" = 1 ]; then
		say "  would replace the link $plugin_dst with a folder"
		return 0
	fi
	rm -f -- "$plugin_dst"
}

place_plugin_file() {
	case $PLUGIN_ACTION in
	conflict) return 0 ;;
	unchanged) UNCHANGED=$((UNCHANGED + 1)) ;;
	update) UPDATED=$((UPDATED + 1)) ;;
	add) ADDED=$((ADDED + 1)) ;;
	esac
	say "$1" >>"$NEW_LIST"
}

remove_file() {
	remove_path=$CONFIG_DIR/$1
	# Never remove a file through the plugin folder's link: that would delete it from the checkout.
	# The link goes with the first of its files, and counts for each.
	case $1 in
	"$PLUGIN_REL"/*)
		if [ "$PLUGIN_UNLINKED" = 1 ]; then
			REMOVED=$((REMOVED + 1))
			return 0
		fi
		if [ -L "$CONFIG_DIR/$PLUGIN_REL" ]; then
			remove_path=$CONFIG_DIR/$PLUGIN_REL
			if ! link_is_ours "$remove_path" "$PLUGIN_REL"; then
				warn "left in place, because it was changed by hand: $remove_path"
				return 0
			fi
			PLUGIN_UNLINKED=1
			REMOVED=$((REMOVED + 1))
			if [ "$DRY_RUN" = 1 ]; then
				say "  would remove $remove_path"
				return 0
			fi
			rm -f -- "$remove_path"
			prune_dirs "$(dirname -- "$remove_path")"
			return 0
		fi
		;;
	esac
	if [ ! -L "$remove_path" ] && [ ! -e "$remove_path" ]; then
		return 0
	fi
	if ! is_ours "$remove_path" "$1"; then
		warn "left in place, because it was changed by hand: $remove_path"
		return 0
	fi
	REMOVED=$((REMOVED + 1))
	if [ "$DRY_RUN" = 1 ]; then
		say "  would remove $remove_path"
		return 0
	fi
	rm -f -- "$remove_path"
	prune_dirs "$(dirname -- "$remove_path")"
}

write_record() {
	record_version=$(sed -n '1p' "$SCRIPT_DIR/VERSION" 2>/dev/null || true)
	mkdir -p -- "$CONFIG_DIR/$NAME"
	{
		say "# $NAME install record, written by install.sh. Do not edit."
		say "platform=$PLATFORM"
		say "mode=$MODE"
		if [ "$MODE" = link ]; then
			say "dist=$DIST_ROOT"
		fi
		if [ -n "$record_version" ]; then
			say "version=$record_version"
		fi
		sed 's/^/file=/' "$NEW_LIST"
	} >"$RECORD.tmp"
	mv -- "$RECORD.tmp" "$RECORD"
}

profile_names() {
	for profile_file in "$SRC_DIR/$NAME"/profiles/*.json; do
		[ -f "$profile_file" ] || continue
		profile_name=${profile_file##*/}
		printf '%s ' "${profile_name%.json}"
	done
}

create_settings() {
	if [ -e "$SETTINGS" ]; then
		if [ -n "$PROFILE_OPT$REVIEW_OPT" ]; then
			say ""
			say "Your settings file already exists and was not changed: $SETTINGS"
			[ -z "$PROFILE_OPT" ] || say "  To use profile $PROFILE_OPT, set the line:  \"profile\": \"$PROFILE_OPT\","
			[ -z "$REVIEW_OPT" ] || say "  To use review policy $REVIEW_OPT, set the line:  \"review\": \"$REVIEW_OPT\","
		fi
		return 0
	fi
	# A project settings file overrides the user's own settings, so it is only written when a
	# value was asked for, and then only with that value.
	if [ "$TARGET" != global ] && [ -z "$PROFILE_OPT$REVIEW_OPT" ]; then
		return 0
	fi
	if [ "$DRY_RUN" = 1 ]; then
		say "  would create $SETTINGS"
		return 0
	fi
	settings_profiles=$(profile_names | sed 's/ $//; s/ /, /g')
	settings_review=0
	settings_profile=0
	if [ "$TARGET" = global ] || [ -n "$REVIEW_OPT" ]; then settings_review=1; fi
	if [ "$TARGET" = global ] || [ -n "$PROFILE_OPT" ]; then settings_profile=1; fi
	mkdir -p -- "$CONFIG_DIR"
	{
		say "{"
		say "  \"\$schema\": \"./$NAME/schema.json\","
		if [ "$settings_review" = 1 ]; then
			settings_comma=
			[ "$settings_profile" = 0 ] || settings_comma=,
			say "  // When the reviewer checks work: auto, ask, always or never."
			say "  \"review\": \"${REVIEW_OPT:-auto}\"$settings_comma"
		fi
		if [ "$settings_profile" = 1 ]; then
			say "  // Which models the agents use: $settings_profiles."
			say "  \"profile\": \"${PROFILE_OPT:-default}\""
		fi
		say "}"
	} >"$SETTINGS"
	say "Created the settings file: $SETTINGS"
}

cmd_install() {
	[ -d "$DIST_ROOT" ] || die "no dist folder in $SCRIPT_DIR. Run git pull, or build it with bun run build."
	require_opencode2
	SRC_DIR=$DIST_ROOT/opencode-$PLATFORM
	FILES_TXT=$SRC_DIR/$NAME/files.txt
	[ -f "$FILES_TXT" ] || die "the checkout is incomplete: $FILES_TXT is missing."
	if [ -n "$PROFILE_OPT" ] && [ ! -f "$SRC_DIR/$NAME/profiles/$PROFILE_OPT.json" ]; then
		die "unknown profile: $PROFILE_OPT. Choose one of: $(profile_names)"
	fi
	if [ -n "$MODE_OPT" ]; then
		MODE=$MODE_OPT
	elif [ "$TARGET" = global ]; then
		MODE='link'
	else
		MODE=copy
	fi

	if [ "$MODE" = link ]; then mode_words="linked to this checkout"; else mode_words="copied"; fi
	if [ "$DRY_RUN" = 1 ]; then
		say "Dry run: nothing will be changed."
	fi
	say "Installing $NAME for opencode 2 into $CONFIG_DIR (files $mode_words)."
	if [ -f "$RECORD" ] && [ "$(recorded_value platform)" = v1 ]; then
		say "The files installed here are for opencode 1, which is no longer supported; they are replaced."
	fi

	NEW_LIST=$(mktemp)
	trap cleanup EXIT
	if [ "$DRY_RUN" = 0 ]; then
		mkdir -p -- "$CONFIG_DIR"
	fi
	if [ "$MODE" = link ]; then link_plugin_dir; else unlink_plugin_dir; fi
	while IFS= read -r rel || [ -n "$rel" ]; do
		[ -n "$rel" ] || continue
		valid_rel "$rel" || die "unexpected path in $FILES_TXT: $rel"
		case $rel in
		"$PLUGIN_REL"/*)
			if [ "$MODE" = link ] || [ "$PLUGIN_ACTION" = conflict ]; then
				place_plugin_file "$rel"
				continue
			fi
			;;
		esac
		place_file "$rel"
	done <"$FILES_TXT"

	{
		if [ -f "$RECORD" ]; then recorded_files; fi
		# The single-file plugin of earlier releases, also when no record names it.
		if [ -L "$CONFIG_DIR/$LEGACY_PLUGIN" ] || [ -e "$CONFIG_DIR/$LEGACY_PLUGIN" ]; then say "$LEGACY_PLUGIN"; fi
	} | sort -u | while IFS= read -r rel; do
		[ -n "$rel" ] || continue
		valid_rel "$rel" || continue
		grep -qxF -- "$rel" "$FILES_TXT" || say "$rel"
	done >"$NEW_LIST.stale"
	while IFS= read -r rel; do
		case $rel in
		"$PLUGIN_REL"/*) [ "$MODE" = copy ] || continue ;;
		esac
		remove_file "$rel"
	done <"$NEW_LIST.stale"
	rm -f -- "$NEW_LIST.stale"

	if [ "$DRY_RUN" = 0 ]; then
		write_record
	fi
	create_settings

	say ""
	if [ "$DRY_RUN" = 1 ]; then
		say "Would do: $ADDED added, $UPDATED updated, $UNCHANGED unchanged, $REMOVED removed."
	else
		say "Done: $ADDED added, $UPDATED updated, $UNCHANGED unchanged, $REMOVED removed."
	fi
	if [ -n "$CONFLICTS" ]; then
		say ""
		say "These files were left alone, because they are not from $NAME:$CONFLICTS"
		say "Move or rename them, then run $PROG again."
	fi
	if [ "$DRY_RUN" = 1 ]; then
		[ -z "$CONFLICTS" ] || exit 1
		return 0
	fi
	say ""
	say "Next: restart opencode. lead becomes the default agent, unless your opencode"
	say "config names another default_agent; press Tab to switch agents. Type /guide to"
	say "learn more, and run $PROG doctor to check the installation."
	[ -z "$CONFLICTS" ] || exit 1
}

# ---------------------------------------------------------------- doctor

FAILS=0
WARNS=0
MASKED=0
ok() { say "  OK    $*"; }
note() {
	say "  WARN  $*"
	WARNS=$((WARNS + 1))
}
fail() {
	say "  FAIL  $*"
	FAILS=$((FAILS + 1))
}

# The value of a top-level string key in a settings file, ignoring comment lines.
settings_value() {
	[ -f "$1" ] || return 0
	sed -n "/^[[:space:]]*\/\//d; s/^[[:space:]]*\"$2\"[[:space:]]*:[[:space:]]*\"\\([^\"]*\\)\".*/\\1/p" "$1" | sed -n '$p'
}

check_settings_file() {
	[ -f "$1" ] || return 0
	check_review=$(settings_value "$1" review)
	check_profile=$(settings_value "$1" profile)
	check_ok=1
	case $check_review in
	'' | auto | ask | always | never) ;;
	*)
		fail "$1: review is \"$check_review\"; use auto, ask, always or never."
		check_ok=0
		;;
	esac
	if [ -n "$check_profile" ] && [ ! -f "$PROFILES_DIR/$check_profile.json" ]; then
		fail "$1: profile \"$check_profile\" does not exist; use one of: $(profile_names)"
		check_ok=0
	fi
	if command -v jq >/dev/null 2>&1; then
		if ! sed -e 's#^[[:space:]]*//.*$##' -e 's#[[:space:]]//[^"]*$##' "$1" | tr '\n' ' ' | sed 's/,[[:space:]]*\([]}]\)/ \1/g' | jq -e . >/dev/null 2>&1; then
			note "$1: could not be read as JSON with comments; check its brackets, quotes and commas."
			check_ok=0
		fi
	fi
	[ -z "$check_profile" ] || EFFECTIVE_PROFILE=$check_profile
	if [ "$check_ok" = 1 ]; then
		ok "settings $1 (profile ${check_profile:-not set}, review ${check_review:-not set})"
	fi
}

cmd_doctor() {
	if [ "$TARGET" = project ]; then
		say "Checking $NAME for the project $PROJECT"
	else
		say "Checking $NAME in $CONFIG_DIR"
	fi
	detect_versions
	if [ -n "$V2_VERSION" ]; then
		if [ "$V2_VERSION" = "$V2_PINNED" ]; then
			ok "opencode $V2_VERSION"
		else
			note "opencode $V2_VERSION; this harness is tested with opencode $V2_PINNED"
		fi
	elif [ -n "$OLD_VERSION" ]; then
		fail "opencode $OLD_VERSION: $UPGRADE_ADVICE"
	else
		fail "opencode not found; install opencode 2 from https://opencode.ai"
	fi

	DOCTOR_TMP=$(mktemp -d)
	trap 'rm -rf -- "$DOCTOR_TMP"' EXIT
	SRC_DIR=$DIST_ROOT/opencode-$PLATFORM
	# The project whose opencode config is checked for a plugins line, and that opencode is asked about.
	LIVE_DIR=${PROJECT:-$PWD}
	find_plugin_line "$LIVE_DIR"
	if [ ! -f "$RECORD" ]; then
		if [ "$TARGET" = project ] && [ -n "$LINE_KIND" ]; then
			check_plugin_line
			doctor_masking
			PROFILES_DIR=$SRC_DIR/$NAME/profiles
			doctor_settings_and_models
			doctor_live
			doctor_summary
		fi
		if [ "$TARGET" = project ]; then
			fail "$NAME is not switched on here: no plugins line names it in the project's opencode config, and no files are installed ($RECORD is missing). Add the line, or run $PROG --project $PROJECT"
		else
			fail "$NAME is not installed here ($RECORD is missing); run $PROG"
		fi
		doctor_summary
	fi

	MODE=$(recorded_value mode)
	PROFILES_DIR=$CONFIG_DIR/$NAME/profiles
	[ -d "$PROFILES_DIR" ] || PROFILES_DIR=$SRC_DIR/$NAME/profiles
	if [ "$(recorded_value platform)" = v1 ]; then
		fail "the files installed here are for opencode 1, which is no longer supported; run $PROG to install the opencode 2 files"
	fi

	check_installed_files
	doctor_masking
	doctor_settings_and_models
	doctor_live
	doctor_summary
}

# A global install and a project's plugins line: the global copy's plugin loads first, and
# opencode drops the project's as "Duplicate plugin ID".
doctor_masking() {
	[ -n "$LINE_KIND" ] || return 0
	if [ "$TARGET" = project ] && [ -f "$RECORD" ]; then
		note "the files installed in $CONFIG_DIR and the plugins line in $LINE_FILE ($LINE_ENTRY) both bring the harness, and the files win; keep one of them"
	fi
	if [ -f "$GLOBAL_DIR/$NAME/installed.txt" ]; then
		MASKED=1
		note "the harness installed in $GLOBAL_DIR masks the one named in $LINE_FILE ($LINE_ENTRY): opencode loads the installed copy and reports the project's as \"Duplicate plugin ID\". Remove the line, or remove the global install with $PROG uninstall"
	fi
}

# ---------------------------------------------------------------- doctor: the plugins line

# The entries of the "plugins" list of a JSON or JSONC config file, one per line: strings, and
# the "package" of an object entry.
plugin_entries() {
	awk '
	{ s = s $0 "\n" }
	END {
		n = length(s)
		p = index(s, "\"plugins\"")
		if (p == 0) exit
		i = p + 9
		while (i <= n && substr(s, i, 1) != "[") {
			c = substr(s, i, 1)
			if (c != " " && c != "\t" && c != "\n" && c != "\r" && c != ":") exit
			i++
		}
		i++
		depth = 1
		key = ""
		while (i <= n && depth > 0) {
			c = substr(s, i, 1)
			if (c == "/" && substr(s, i + 1, 1) == "/") {
				while (i <= n && substr(s, i, 1) != "\n") i++
				continue
			}
			if (c == "/" && substr(s, i + 1, 1) == "*") {
				j = index(substr(s, i + 2), "*/")
				if (j == 0) exit
				i = i + j + 3
				continue
			}
			if (c == "[" || c == "{") depth++
			else if (c == "]" || c == "}") depth--
			else if (c == "\"") {
				out = ""
				i++
				while (i <= n) {
					c = substr(s, i, 1)
					if (c == "\\") { out = out substr(s, i + 1, 1); i += 2; continue }
					if (c == "\"") break
					out = out c
					i++
				}
				j = i + 1
				while (substr(s, j, 1) == " " || substr(s, j, 1) == "\t") j++
				if (substr(s, j, 1) == ":") key = out
				else {
					if (depth == 1 || (depth == 2 && key == "package")) print out
					key = ""
				}
			}
			i++
		}
	}' "$1"
}

# A plugins entry as a folder: {env:VAR} filled in, relative to the config file, file:// removed.
# Prints nothing for a package name.
entry_folder() {
	entry_value=$1
	while :; do
		case $entry_value in
		*'{env:'*'}'*) ;;
		*) break ;;
		esac
		entry_var=${entry_value#*\{env:}
		entry_var=${entry_var%%\}*}
		case $entry_var in '' | [!A-Za-z_]* | *[!A-Za-z0-9_]*) return 0 ;; esac
		entry_env=$(eval "printf '%s' \"\${$entry_var-}\"")
		entry_value="${entry_value%%\{env:"$entry_var"\}*}$entry_env${entry_value#*\{env:"$entry_var"\}}"
	done
	case $entry_value in
	file://*) entry_value=${entry_value#file://} ;;
	esac
	case $entry_value in
	./* | ../*) say "$(dirname -- "$2")/$entry_value" ;;
	/*) say "$entry_value" ;;
	esac
}

# Finds a plugins line for the harness in the project at $1. Sets LINE_KIND (npm, checkout or
# folder; empty when there is none), LINE_ENTRY, LINE_FILE and LINE_DIR.
find_plugin_line() {
	LINE_KIND=
	LINE_ENTRY=
	LINE_FILE=
	LINE_DIR=
	for line_file in "$1/opencode.json" "$1/opencode.jsonc" "$1/.opencode/opencode.json" "$1/.opencode/opencode.jsonc"; do
		[ -f "$line_file" ] || continue
		plugin_entries "$line_file" >"$DOCTOR_TMP/entries" || continue
		while IFS= read -r line_entry; do
			case $line_entry in
			"$NPM_NAME" | "$NPM_NAME"@*)
				LINE_KIND=npm
				;;
			*)
				line_dir=$(entry_folder "$line_entry" "$line_file")
				[ -n "$line_dir" ] || continue
				if [ -d "$line_dir" ]; then line_dir=$(CDPATH='' cd -- "$line_dir" && pwd -P); fi
				if [ -f "$line_dir/package.json" ] && grep -q "\"name\"[[:space:]]*:[[:space:]]*\"$NPM_NAME\"" "$line_dir/package.json"; then
					LINE_KIND=checkout
				elif [ -f "$line_dir/index.js" ] && sed -n '1p' "$line_dir/index.js" | grep -qxF -- "$MARKER_JS"; then
					LINE_KIND=folder
				else
					case $line_dir in
					*/"$NAME" | */"$NAME"/) LINE_KIND=checkout ;;
					*) continue ;;
					esac
				fi
				LINE_DIR=$line_dir
				;;
			esac
			LINE_ENTRY=$line_entry
			LINE_FILE=$line_file
			return 0
		done <"$DOCTOR_TMP/entries"
	done
}

check_plugin_line() {
	ok "switched on by the plugins line in $LINE_FILE: $LINE_ENTRY"
	case $LINE_KIND in
	npm)
		ok "opencode installs the package $LINE_ENTRY itself; the check below shows whether it loaded"
		;;
	checkout)
		if [ ! -f "$LINE_DIR/package.json" ] || [ ! -f "$LINE_DIR/server.js" ]; then
			fail "$LINE_DIR is not a checkout of $NAME (package.json or server.js is missing); clone it there, or fix the line"
		elif [ ! -f "$LINE_DIR/dist/opencode-v2/$PLUGIN_REL/index.js" ] || [ ! -f "$LINE_DIR/dist/opencode-v2/$PLUGIN_REL/tui.js" ]; then
			fail "the checkout $LINE_DIR has no plugin folder (dist/opencode-v2/$PLUGIN_REL); run git pull there"
		else
			ok "the checkout $LINE_DIR has the plugin folder"
		fi
		;;
	folder)
		ok "the plugin folder $LINE_DIR is there"
		;;
	esac
}

# ---------------------------------------------------------------- doctor: asking opencode

# The values of a key in JSON on standard input, one per line: strings unescaped, other values as
# written.
json_values() {
	awk -v key="$1" '
	{ s = s $0 "\n" }
	END {
		n = length(s)
		pattern = "\"" key "\":"
		i = 1
		while ((p = index(substr(s, i), pattern)) > 0) {
			i = i + p - 1 + length(pattern)
			while (substr(s, i, 1) == " ") i++
			# A list: its first item.
			if (substr(s, i, 1) == "[") {
				i++
				while (substr(s, i, 1) == " ") i++
			}
			if (substr(s, i, 1) == "\"") {
				out = ""
				i++
				while (i <= n) {
					c = substr(s, i, 1)
					if (c == "\\") {
						d = substr(s, i + 1, 1)
						if (d == "n") out = out "\n"
						else if (d == "t") out = out "\t"
						else if (d == "u") { out = out "?"; i += 4 }
						else out = out d
						i += 2
						continue
					}
					if (c == "\"") break
					out = out c
					i++
				}
				print out
			} else {
				out = ""
				while (i <= n && index(",}] \n", substr(s, i, 1)) == 0) { out = out substr(s, i, 1); i++ }
				print out
			}
		}
	}'
}

json_value() {
	json_values "$1" <"$DOCTOR_TMP/live" | sed -n '1p'
}

# Ask opencode, through the plugin's RPC, how it sees the project: a private server waits until
# the plugins are active, which the shared service's agent list does not.
doctor_live() {
	if [ -z "$OPENCODE_BIN" ]; then
		note "cannot ask opencode about the agents without opencode 2"
		return 0
	fi
	say "  ...   asking opencode about $LIVE_DIR"
	if (cd "$LIVE_DIR" && "$OPENCODE_BIN" api --standalone POST "/api/rpc/$NAME/doctor" -d '{"input":{}}' -H "x-opencode-directory:$LIVE_DIR") >"$DOCTOR_TMP/live" 2>&1; then
		live_ok=1
	else
		live_ok=0
	fi
	if [ "$live_ok" = 0 ] || ! grep -q '"output"' "$DOCTOR_TMP/live"; then
		if grep -q 'rpc.unavailable' "$DOCTOR_TMP/live"; then
			fail "the $NAME plugin is not active in $LIVE_DIR, so opencode has no lead there. Run $PROG again or check the plugins line, then look for errors in: opencode debug config, or opencode --print-logs"
		else
			fail "could not ask opencode about $LIVE_DIR: $(sed -n '1p' "$DOCTOR_TMP/live")"
		fi
		return 0
	fi
	live_version=$(json_value version)
	live_source=$(json_value leadSource)
	if [ "$(json_value leadLoaded)" = true ]; then
		case $live_source in
		files) ok "lead is loaded from files ($(json_value leadFiles)), with the plugin $live_version active" ;;
		*) ok "lead is loaded from the plugin $live_version" ;;
		esac
	else
		fail "opencode has no lead in $LIVE_DIR although the plugin $live_version is active; an opencode config there may disable it"
	fi
	live_review=$(json_value reviewLine)
	case $live_review in
	'' | null) note "lead's prompt has no \"Review policy:\" line; a changed agent file may hide it" ;;
	*) ok "lead's $live_review" ;;
	esac
	live_default=$(json_value defaultAgent)
	if [ "$live_default" = lead ]; then
		ok "lead is the default agent"
	else
		note "the default agent is ${live_default:-none}, not lead: a default_agent in an opencode config, or \"default_agent\": false in the settings, chooses it"
	fi
	json_values problem <"$DOCTOR_TMP/live" >"$DOCTOR_TMP/problems"
	while IFS= read -r live_problem; do
		[ -n "$live_problem" ] || continue
		note "$live_problem"
	done <"$DOCTOR_TMP/problems"
	if [ "$MASKED" = 0 ] && grep -q "Duplicate plugin ID: $NAME" "$DOCTOR_TMP/live"; then
		note "opencode loaded $NAME twice and kept the first (\"Duplicate plugin ID\"): a global install masks a project's plugins line"
	fi
}

# The files an install recorded: present, still ours, and matching this checkout.
check_installed_files() {
	recorded_files >"$DOCTOR_TMP/recorded"
	doctor_files=0
	doctor_bad=0
	while IFS= read -r rel; do
		[ -n "$rel" ] || continue
		doctor_files=$((doctor_files + 1))
		doctor_path=$CONFIG_DIR/$rel
		if [ -L "$doctor_path" ] && [ ! -e "$doctor_path" ]; then
			fail "broken link: $doctor_path (was the checkout moved? run $PROG)"
			doctor_bad=$((doctor_bad + 1))
		elif [ ! -e "$doctor_path" ]; then
			fail "missing: $doctor_path (run $PROG)"
			doctor_bad=$((doctor_bad + 1))
		elif ! is_ours "$doctor_path" "$rel"; then
			note "changed by hand, not from $NAME: $doctor_path"
			doctor_bad=$((doctor_bad + 1))
		elif [ "$MODE" = copy ] && [ -f "$SRC_DIR/$rel" ] && ! cmp -s -- "$SRC_DIR/$rel" "$doctor_path"; then
			note "older than this checkout: $doctor_path (run $PROG to update)"
			doctor_bad=$((doctor_bad + 1))
		fi
	done <"$DOCTOR_TMP/recorded"
	if [ "$doctor_bad" = 0 ]; then
		ok "$doctor_files files installed ($MODE)"
	fi
	if [ -f "$SRC_DIR/$NAME/files.txt" ]; then
		sort -u "$DOCTOR_TMP/recorded" >"$DOCTOR_TMP/recorded.sorted"
		sort -u "$SRC_DIR/$NAME/files.txt" >"$DOCTOR_TMP/dist.sorted"
		if ! cmp -s "$DOCTOR_TMP/recorded.sorted" "$DOCTOR_TMP/dist.sorted"; then
			note "this checkout has a different set of files; run $PROG to bring the installation up to date"
		fi
	fi
}

# Settings files and the profile's models.
doctor_settings_and_models() {
	EFFECTIVE_PROFILE=default
	if [ -n "${OPENCODE_CONFIG_DIR-}" ]; then
		check_settings_file "$OPENCODE_CONFIG_DIR/$NAME.jsonc"
	fi
	if [ -f "$GLOBAL_DIR/$NAME.jsonc" ]; then
		check_settings_file "$GLOBAL_DIR/$NAME.jsonc"
	elif [ "$TARGET" = global ]; then
		note "no settings file ($GLOBAL_DIR/$NAME.jsonc); the defaults apply: profile default, review auto"
	fi
	if [ "$TARGET" = project ]; then
		check_settings_file "$SETTINGS"
	fi

	doctor_profile=$PROFILES_DIR/$EFFECTIVE_PROFILE.json
	if [ ! -f "$doctor_profile" ]; then
		fail "profile file missing: $doctor_profile"
	else
		doctor_models=$(sed -n 's/^[[:space:]]*"model":[[:space:]]*"\([^"]*\)".*/\1/p' "$doctor_profile" | sort -u)
		if [ -z "$doctor_models" ]; then
			ok "profile $EFFECTIVE_PROFILE: every agent uses the model chosen in the session"
		elif [ -z "$OPENCODE_BIN" ]; then
			note "cannot check the models of profile $EFFECTIVE_PROFILE without opencode 2"
		else
			doctor_available=$("$OPENCODE_BIN" models 2>/dev/null || true)
			doctor_missing=
			for doctor_model in $doctor_models; do
				printf '%s\n' "$doctor_available" | grep -qxF -- "$doctor_model" || doctor_missing="$doctor_missing $doctor_model"
			done
			if [ -z "$doctor_missing" ]; then
				ok "profile $EFFECTIVE_PROFILE: all its models are available"
			else
				note "profile $EFFECTIVE_PROFILE: not available:$doctor_missing. Connect the provider with \"opencode auth login\", or choose another profile in your settings file."
			fi
		fi
	fi

}

doctor_summary() {
	say ""
	if [ "$FAILS" -gt 0 ]; then
		say "$FAILS problem(s) and $WARNS warning(s) found."
		exit 1
	fi
	if [ "$WARNS" -gt 0 ]; then
		say "No problems; $WARNS warning(s)."
	else
		say "All good."
	fi
	exit 0
}

# ---------------------------------------------------------------- uninstall

cmd_uninstall() {
	if [ -f "$RECORD" ]; then
		UNINSTALL_LIST=$(recorded_files)
	elif [ -d "$DIST_ROOT" ]; then
		UNINSTALL_LIST=$(cat "$DIST_ROOT"/opencode-v2/"$NAME"/files.txt 2>/dev/null || true)
	else
		die "no installation record in $CONFIG_DIR, and no dist folder to compare with"
	fi
	if [ "$DRY_RUN" = 1 ]; then
		say "Dry run: nothing will be changed."
	fi
	say "Removing $NAME from $CONFIG_DIR."
	while IFS= read -r rel; do
		[ -n "$rel" ] || continue
		valid_rel "$rel" || continue
		remove_file "$rel"
	done <<EOF
$UNINSTALL_LIST
EOF
	if [ -d "$CONFIG_DIR/$NAME" ]; then
		if [ "$DRY_RUN" = 1 ]; then
			say "  would remove $CONFIG_DIR/$NAME/"
		else
			rm -rf -- "${CONFIG_DIR:?}/$NAME"
		fi
	fi
	if [ -e "$SETTINGS" ]; then
		if [ "$PURGE" = 1 ]; then
			if [ "$DRY_RUN" = 1 ]; then
				say "  would remove $SETTINGS"
			else
				rm -f -- "$SETTINGS"
				say "Removed your settings file."
			fi
		else
			say "Kept your settings file: $SETTINGS (remove it with --purge)."
		fi
	fi
	if [ "$DRY_RUN" = 1 ]; then
		say "Would remove $REMOVED files."
	else
		say "Done: $REMOVED files removed. Restart opencode."
	fi
}

case $COMMAND in
install) cmd_install ;;
doctor) cmd_doctor ;;
uninstall) cmd_uninstall ;;
esac
