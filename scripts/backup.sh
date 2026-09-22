#!/usr/bin/env bash
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."
mkdir -p backups
exec 9>backups/backup.lock
flock -n 9 || exit 0
key="$HOME/.config/english-bot/backup.key"
test -s "$key" || { echo 'Backup key is not configured' >&2; exit 1; }
archive="backups/english-$(date -u +%Y%m%dT%H%M%SZ).dump.gpg"
test ! -e "$archive" || exit 1
docker compose --env-file deploy/compose.env exec -T db pg_dump -U english -d english --format=custom --no-owner --no-privileges |
  gpg --batch --yes --pinentry-mode loopback --passphrase-file "$key" --symmetric --cipher-algo AES256 --output "$archive.partial"
test -s "$archive.partial"
mv "$archive.partial" "$archive"
sha256sum "$archive" > "$archive.sha256"
date -u +%s > backups/last-success
mkdir -p deploy/backup-status
date -u +%s > deploy/backup-status/backup-success.tmp
chmod 755 deploy/backup-status
chmod 644 deploy/backup-status/backup-success.tmp
mv deploy/backup-status/backup-success.tmp deploy/backup-status/backup-success
echo "Encrypted backup completed: $(basename "$archive")"
