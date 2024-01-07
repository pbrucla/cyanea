#!/bin/sh

set -eu

CONFIG="${1:-}"
CWD="${2:-}"
NOW="${3:-}"

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

node cyanea.mjs "$@"
