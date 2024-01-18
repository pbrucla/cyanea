#!/bin/sh

set -eu

CONFIG="${1:-}"
CWD="${2:-}"
NOW="${3:-}"
FORCE_RESYNC_DISCORD_IMAGES="${4:-}"

if [ ! -z "$CONFIG" ]; then
	set -- --config "$CONFIG"
else
  set --
fi

if [ ! -z "$CWD" ]; then
	set -- "$@" --cwd "$CWD"
fi

if [ ! -z "$NOW" ]; then
	set -- "$@" --now "$NOW"
fi

if [ ! -z "$FORCE_RESYNC_DISCORD_IMAGES" ]; then
	export CYANEA_DISCORD_FORCE_RESYNC_IMAGES="$FORCE_RESYNC_DISCORD_IMAGES"
fi

node /cyanea/cyanea.mjs "$@"
