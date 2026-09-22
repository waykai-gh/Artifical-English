#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
shopt -s nullglob
archives=(backups/english-*.dump.gpg)
(( ${#archives[@]} > 0 )) || { echo 'No encrypted backups available' >&2; exit 1; }
bash scripts/restore-check.sh "${archives[-1]}"
