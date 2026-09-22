#!/usr/bin/env bash
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."
mkdir -p backups
exec 9>backups/restore.lock
flock -n 9 || exit 0
archive="${1:?Provide an encrypted backup from backups/}"
[[ "$archive" =~ ^backups/english-[0-9]{8}T[0-9]{6}Z\.dump\.gpg$ ]] || { echo 'Only managed backup files are accepted' >&2; exit 1; }
test -f "$archive"
sha256sum --check "$archive.sha256" >/dev/null
key="$HOME/.config/english-bot/backup.key"
scratch="restore_check_$(date -u +%s)_$$"
compose=(docker compose --env-file deploy/compose.env)
"${compose[@]}" exec -T db createdb -U english "$scratch"
# Only the uniquely named database created above is removed, never the live DB.
trap '"${compose[@]}" exec -T db dropdb -U english "$scratch"' EXIT
gpg --batch --quiet --pinentry-mode loopback --passphrase-file "$key" --decrypt "$archive" |
  "${compose[@]}" exec -T db pg_restore -U english -d "$scratch" --no-owner --no-privileges --exit-on-error
"${compose[@]}" exec -T db psql -U english -d "$scratch" -v ON_ERROR_STOP=1 -Atc \
  'SELECT count(*) FROM app_users; SELECT count(*) FROM vocabulary_items; SELECT count(*) FROM turns;' >/dev/null
date -u +%s > backups/last-restore-check
mkdir -p deploy/backup-status
date -u +%s > deploy/backup-status/restore-success.tmp
chmod 755 deploy/backup-status
chmod 644 deploy/backup-status/restore-success.tmp
mv deploy/backup-status/restore-success.tmp deploy/backup-status/restore-success
echo 'Restore verified in an isolated temporary database; live database unchanged.'
