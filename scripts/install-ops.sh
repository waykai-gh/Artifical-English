#!/usr/bin/env bash
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."
test "$(id -un)" = codex || { echo 'Install operational jobs as codex' >&2; exit 1; }
project="$(pwd -P)"
[[ "$project" =~ ^/[A-Za-z0-9_/-]+$ ]] || { echo 'Cron requires a simple absolute deployment path' >&2; exit 1; }
mkdir -p .tmp "$HOME/.config/english-bot"
chmod 700 "$HOME/.config/english-bot"
if ! test -s "$HOME/.config/english-bot/backup.key"; then
  openssl rand -hex 32 > "$HOME/.config/english-bot/backup.key"
fi
chmod 600 "$HOME/.config/english-bot/backup.key"
if ! LC_ALL=C crontab -l > .tmp/crontab.before 2>.tmp/crontab.error; then
  grep -q 'no crontab' .tmp/crontab.error || { echo 'Could not safely read existing crontab' >&2; exit 1; }
fi
awk '/^# BEGIN english-bot operations$/{skip=1;next} /^# END english-bot operations$/{skip=0;next} !skip{print}' .tmp/crontab.before > .tmp/crontab.next
cat >> .tmp/crontab.next <<EOF
# BEGIN english-bot operations
17 3 * * * /bin/bash $project/scripts/backup.sh >> $project/.tmp/operations-cron.log 2>&1
47 3 * * 0 /bin/bash $project/scripts/scheduled-restore.sh >> $project/.tmp/operations-cron.log 2>&1
*/2 * * * * /bin/bash $project/scripts/watchdog.sh >> $project/.tmp/operations-cron.log 2>&1
# END english-bot operations
EOF
crontab .tmp/crontab.next
echo 'Installed daily encrypted backup, weekly isolated restore and two-minute health watchdog.'
