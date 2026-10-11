#!/bin/sh
# SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
#
# SPDX-License-Identifier: Apache-2.0

# Install, check or remove the ecmwf-multi-agents harness for opencode.
# Run "./install.sh --help" for usage. Needs only standard tools (sed, grep, cmp, ln, cp,
# readlink); jq is used by doctor when it is installed.

set -eu

NAME=ecmwf-multi-agents
MARKER_MD="# managed by $NAME"
MARKER_JS="// managed by $NAME"
V2_PINNED=2.0.16

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)

say() { printf '%s\n' "$*"; }
warn() { printf 'Warning: %s\n' "$*" >&2; }
die() {
	printf 'Error: %s\n' "$*" >&2
	exit 1
}

usage() {
	cat <<'EOF'
Usage: ./install.sh [command] [options]

Commands:
  install     Install or update the harness (the default).
  doctor      Check an installation and explain any problem found.
  uninstall   Remove the harness files. Your settings file stays unless you add --purge.

Where (default: your own opencode config folder, ~/.config/opencode):
  --project DIR     Install for one project only, into DIR/.opencode (files are copied).
  --central DIR     Prepare DIR as a shared install for opencode 1.x on a shared machine
                    (files are copied); users then set OPENCODE_CONFIG_DIR=DIR.

Options:
  --profile NAME    Which models the agents use: default, anthropic, copilot or inherit.
  --review WHEN     When the reviewer checks work: auto, ask, always or never.
  --platform v1|v2  Use the opencode 1.x or 2 file format (normally detected).
  --link, --copy    Link the files to this checkout (they update with git pull) or copy them.
  --dry-run         Show what would happen, change nothing.
  --purge           With uninstall: also remove the settings file.
  -h, --help        Show this help.

Examples:
  ./install.sh
  ./install.sh --profile anthropic --review always
  ./install.sh --project ~/code/my-repo
  ./install.sh doctor
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
CENTRAL=
PLATFORM_OPT=
PROFILE_OPT=
REVIEW_OPT=
MODE_OPT=
DRY_RUN=0
PURGE=0

need_value() {
	[ -n "${2-}" ] || die "$1 needs a value (see ./install.sh --help)"
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
	--central)
		need_value "$@"
		CENTRAL=$2
		shift 2
		;;
	--central=*)
		CENTRAL=${1#*=}
		shift
		;;
	--platform)
		need_value "$@"
		PLATFORM_OPT=$2
		shift 2
		;;
	--platform=*)
		PLATFORM_OPT=${1#*=}
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
	*) die "unknown option: $1 (see ./install.sh --help)" ;;
	esac
done

[ -z "$PROJECT" ] || [ -z "$CENTRAL" ] || die "use --project or --central, not both"
case $PLATFORM_OPT in '' | v1 | v2) ;; *) die "--platform must be v1 or v2" ;; esac
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
elif [ -n "$CENTRAL" ]; then
	case $CENTRAL in /*) ;; *) CENTRAL=$(pwd -P)/$CENTRAL ;; esac
	CONFIG_DIR=$CENTRAL
	TARGET=central
else
	CONFIG_DIR=$GLOBAL_DIR
	TARGET=global
fi
RECORD=$CONFIG_DIR/$NAME/installed.txt
SETTINGS=$CONFIG_DIR/$NAME.jsonc

# ---------------------------------------------------------------- opencode versions

V1_VERSION=
V2_VERSION=

version_of() {
	"$1" --version 2>/dev/null | sed -n 's/^[^0-9]*\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\).*$/\1/p' | sed -n '1p'
}

classify_version() {
	case $1 in
	1.*) [ -n "$V1_VERSION" ] || V1_VERSION=$1 ;;
	2.*) [ -n "$V2_VERSION" ] || V2_VERSION=$1 ;;
	esac
}

detect_versions() {
	for detect_bin in opencode opencode2; do
		if command -v "$detect_bin" >/dev/null 2>&1; then
			classify_version "$(version_of "$detect_bin" || true)"
		fi
	done
}

# The opencode command for a platform: v1 is always "opencode"; for v2 prefer "opencode2",
# because a machine with both versions may have the 1.x binary as "opencode".
opencode_for() {
	if [ "$1" = v2 ] && command -v opencode2 >/dev/null 2>&1; then
		say opencode2
	else
		say opencode
	fi
}

choose_platform() {
	detect_versions
	if [ -n "$PLATFORM_OPT" ]; then
		PLATFORM=$PLATFORM_OPT
		if [ "$PLATFORM" = v2 ] && [ -n "$V1_VERSION" ]; then
			warn "opencode $V1_VERSION is installed. It reads opencode 2 files without their safety rules. Install the v1 files instead unless this folder is only used by opencode 2."
		fi
		if [ "$PLATFORM" = v1 ] && [ -z "$V1_VERSION" ] && [ -z "$V2_VERSION" ]; then
			warn "opencode was not found on this machine."
		fi
	elif [ -n "$V1_VERSION" ]; then
		PLATFORM=v1
	elif [ -n "$V2_VERSION" ]; then
		PLATFORM=v2
	else
		die "opencode was not found. Install it first (see https://opencode.ai), then run this again. To install anyway, add --platform v1."
	fi
	if [ "$PLATFORM" = v2 ] && [ -n "$V2_VERSION" ] && [ "$V2_VERSION" != "$V2_PINNED" ]; then
		warn "opencode $V2_VERSION found; this harness is tested with opencode $V2_PINNED."
	fi
	if [ "$TARGET" = central ] && [ "$PLATFORM" = v2 ]; then
		die "a central install works with opencode 1.x only; opencode 2 is not supported for it yet."
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
# another copy of the harness (an old checkout, or the other platform's files).
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

remove_file() {
	remove_path=$CONFIG_DIR/$1
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
	record_version=$(sed -n 's/^  "version": "\([^"]*\)".*/\1/p' "$SCRIPT_DIR/package.json" 2>/dev/null | sed -n '1p' || true)
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
	# A project or central settings file overrides the user's own settings, so it is only
	# written when a value was asked for, and then only with that value.
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
	choose_platform
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
	say "Installing $NAME for opencode $PLATFORM into $CONFIG_DIR (files $mode_words)."

	NEW_LIST=$(mktemp)
	trap cleanup EXIT
	if [ "$DRY_RUN" = 0 ]; then
		mkdir -p -- "$CONFIG_DIR"
	fi
	while IFS= read -r rel || [ -n "$rel" ]; do
		[ -n "$rel" ] || continue
		valid_rel "$rel" || die "unexpected path in $FILES_TXT: $rel"
		place_file "$rel"
	done <"$FILES_TXT"

	if [ -f "$RECORD" ]; then
		recorded_files | while IFS= read -r rel; do
			[ -n "$rel" ] || continue
			valid_rel "$rel" || continue
			grep -qxF -- "$rel" "$FILES_TXT" || say "$rel"
		done >"$NEW_LIST.stale"
		while IFS= read -r rel; do
			remove_file "$rel"
		done <"$NEW_LIST.stale"
		rm -f -- "$NEW_LIST.stale"
	fi

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
		say "Move or rename them, then run ./install.sh again."
	fi
	if [ "$DRY_RUN" = 1 ]; then
		[ -z "$CONFLICTS" ] || exit 1
		return 0
	fi
	say ""
	case $TARGET in
	central)
		say "To use this shared install, each user sets one environment variable, for example"
		say "in a module file:"
		say "  sh, bash:  export OPENCODE_CONFIG_DIR=$CONFIG_DIR"
		say "  Lmod:      setenv(\"OPENCODE_CONFIG_DIR\", \"$CONFIG_DIR\")"
		say "  Tcl:       setenv OPENCODE_CONFIG_DIR $CONFIG_DIR"
		say "See docs/install.md for making the folder read-only."
		;;
	*)
		say "Next: restart opencode. lead becomes the default agent, unless your opencode"
		say "config names another default_agent; press Tab to switch agents. Type /guide to"
		say "learn more, and run ./install.sh doctor to check the installation."
		;;
	esac
	[ -z "$CONFLICTS" ] || exit 1
}

# ---------------------------------------------------------------- doctor

FAILS=0
WARNS=0
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

# Run opencode for the checks, from a folder that shows the installation being checked: the
# project for a project install, otherwise an empty folder, so no project config interferes.
run_opencode() {
	if [ "$TARGET" = project ]; then
		(cd -- "$PROJECT" && "$@")
	elif [ "$TARGET" = central ]; then
		(cd -- "$DOCTOR_RUN" && OPENCODE_CONFIG_DIR=$CONFIG_DIR "$@")
	else
		(cd -- "$DOCTOR_RUN" && "$@")
	fi
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
	[ -z "$check_review" ] || EFFECTIVE_REVIEW=$check_review
	[ -z "$check_profile" ] || EFFECTIVE_PROFILE=$check_profile
	if [ "$check_ok" = 1 ]; then
		ok "settings $1 (profile ${check_profile:-not set}, review ${check_review:-not set})"
	fi
}

cmd_doctor() {
	say "Checking $NAME in $CONFIG_DIR"
	detect_versions
	if [ -n "$V1_VERSION" ]; then ok "opencode $V1_VERSION"; fi
	if [ -n "$V2_VERSION" ]; then
		if [ "$V2_VERSION" = "$V2_PINNED" ]; then
			ok "opencode $V2_VERSION"
		else
			note "opencode $V2_VERSION; this harness is tested with opencode $V2_PINNED"
		fi
	fi
	if [ -z "$V1_VERSION$V2_VERSION" ]; then
		fail "opencode not found; install it from https://opencode.ai"
	fi

	if [ ! -f "$RECORD" ]; then
		fail "$NAME is not installed here ($RECORD is missing); run ./install.sh"
		doctor_summary
	fi
	PLATFORM=$(recorded_value platform)
	MODE=$(recorded_value mode)
	SRC_DIR=$DIST_ROOT/opencode-$PLATFORM
	PROFILES_DIR=$CONFIG_DIR/$NAME/profiles
	[ -d "$PROFILES_DIR" ] || PROFILES_DIR=$SRC_DIR/$NAME/profiles
	if [ "$PLATFORM" = v2 ] && [ -n "$V1_VERSION" ]; then
		fail "the opencode 2 files are installed, but opencode $V1_VERSION reads them without their safety rules; run ./install.sh to switch to the v1 files"
	elif [ "$PLATFORM" = v1 ] && [ -z "$V1_VERSION" ] && [ -n "$V2_VERSION" ]; then
		ok "opencode 1.x files installed; opencode 2 reads them"
	fi

	DOCTOR_TMP=$(mktemp -d)
	trap 'rm -rf -- "$DOCTOR_TMP"' EXIT
	recorded_files >"$DOCTOR_TMP/recorded"
	doctor_files=0
	doctor_bad=0
	while IFS= read -r rel; do
		[ -n "$rel" ] || continue
		doctor_files=$((doctor_files + 1))
		doctor_path=$CONFIG_DIR/$rel
		if [ -L "$doctor_path" ] && [ ! -e "$doctor_path" ]; then
			fail "broken link: $doctor_path (was the checkout moved? run ./install.sh)"
			doctor_bad=$((doctor_bad + 1))
		elif [ ! -e "$doctor_path" ]; then
			fail "missing: $doctor_path (run ./install.sh)"
			doctor_bad=$((doctor_bad + 1))
		elif ! is_ours "$doctor_path" "$rel"; then
			note "changed by hand, not from $NAME: $doctor_path"
			doctor_bad=$((doctor_bad + 1))
		elif [ "$MODE" = copy ] && [ -f "$SRC_DIR/$rel" ] && ! cmp -s -- "$SRC_DIR/$rel" "$doctor_path"; then
			note "older than this checkout: $doctor_path (run ./install.sh to update)"
			doctor_bad=$((doctor_bad + 1))
		fi
	done <"$DOCTOR_TMP/recorded"
	if [ "$doctor_bad" = 0 ]; then
		ok "$doctor_files files installed for opencode $PLATFORM ($MODE)"
	fi
	if [ -f "$SRC_DIR/$NAME/files.txt" ]; then
		sort -u "$DOCTOR_TMP/recorded" >"$DOCTOR_TMP/recorded.sorted"
		sort -u "$SRC_DIR/$NAME/files.txt" >"$DOCTOR_TMP/dist.sorted"
		if ! cmp -s "$DOCTOR_TMP/recorded.sorted" "$DOCTOR_TMP/dist.sorted"; then
			note "this checkout has a different set of files; run ./install.sh to bring the installation up to date"
		fi
	fi

	EFFECTIVE_PROFILE=default
	EFFECTIVE_REVIEW=auto
	if [ -n "${OPENCODE_CONFIG_DIR-}" ] && [ "$TARGET" != central ]; then
		check_settings_file "$OPENCODE_CONFIG_DIR/$NAME.jsonc"
	fi
	if [ "$TARGET" = central ]; then
		check_settings_file "$SETTINGS"
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
	doctor_bin=$(opencode_for "$PLATFORM")
	if [ ! -f "$doctor_profile" ]; then
		fail "profile file missing: $doctor_profile"
	else
		doctor_models=$(sed -n 's/^[[:space:]]*"model":[[:space:]]*"\([^"]*\)".*/\1/p' "$doctor_profile" | sort -u)
		if [ -z "$doctor_models" ]; then
			ok "profile $EFFECTIVE_PROFILE: every agent uses the model chosen in the session"
		elif ! command -v "$doctor_bin" >/dev/null 2>&1; then
			note "cannot check the models of profile $EFFECTIVE_PROFILE without $doctor_bin"
		else
			doctor_available=$("$doctor_bin" models 2>/dev/null || true)
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

	if [ "$PLATFORM" = v1 ] && [ -n "$V1_VERSION" ]; then
		mkdir -p -- "$DOCTOR_TMP/run"
		DOCTOR_RUN=$DOCTOR_TMP/run
		if doctor_agent=$(run_opencode opencode debug agent lead 2>&1); then
			ok "opencode loads the lead agent"
			if command -v jq >/dev/null 2>&1; then
				doctor_lead_review=$(printf '%s\n' "$doctor_agent" | jq -r '.prompt // ""' 2>/dev/null | sed -n 's/^Review policy: //p' | sed -n '1p')
				if [ -n "$doctor_lead_review" ] && [ "$doctor_lead_review" != "$EFFECTIVE_REVIEW" ]; then
					note "lead uses review policy $doctor_lead_review, but your settings say $EFFECTIVE_REVIEW: the plugin is not active (is plugins/$NAME.js installed?)"
				fi
				doctor_default=$(run_opencode opencode debug config 2>/dev/null | jq -r '.default_agent // ""' 2>/dev/null || true)
				if [ "$doctor_default" = lead ]; then
					ok "opencode starts on lead"
				elif [ -n "$doctor_default" ]; then
					note "opencode starts on $doctor_default, because your opencode config names it; press Tab to switch to lead"
				else
					note "opencode starts on its own build agent; press Tab to switch to lead"
				fi
			fi
		else
			fail "opencode could not load the lead agent: $(printf '%s\n' "$doctor_agent" | sed -n '$p')"
		fi
	elif [ "$PLATFORM" = v2 ]; then
		note "on opencode 2 the agents cannot be checked from the shell; start opencode2 and press Tab to see lead"
	fi
	doctor_summary
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
		UNINSTALL_LIST=$(cat "$DIST_ROOT"/opencode-v1/"$NAME"/files.txt "$DIST_ROOT"/opencode-v2/"$NAME"/files.txt 2>/dev/null | sort -u)
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
