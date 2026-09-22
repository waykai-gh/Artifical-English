#!/usr/bin/env bash
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."
mkdir -p .tmp
exec 9>.tmp/watchdog.lock
flock -n 9 || exit 0
compose=(docker compose --env-file deploy/compose.env)
container="$("${compose[@]}" ps -q bot)"
test -n "$container" || { echo 'Bot container missing; manual check required' >&2; exit 1; }
state="$(docker inspect -f '{{.State.Health.Status}}' "$container")"
test "$state" = unhealthy || exit 0
now="$(date -u +%s)"
last=0
test ! -f .tmp/watchdog-last-restart || read -r last < .tmp/watchdog-last-restart
[[ "$last" =~ ^[0-9]+$ ]] || exit 1
(( now - last >= 900 )) || exit 0
printf '%s\n' "$now" > .tmp/watchdog-last-restart
echo 'Confirmed unhealthy bot; one controlled restart (15-minute cooldown).'
"${compose[@]}" restart bot
