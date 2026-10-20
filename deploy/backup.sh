#!/usr/bin/env bash
#
# Копия базы данных без остановки сервиса. `cp` на живой sqlite-файле недопустим:
# можно снять полузаписанное состояние, поэтому используется sqlite3 ".backup"
# (ReadWrite lock snapshot, читается потом без ошибок).
#
#   bash deploy/backup.sh                      база из /opt/feedback, копии в /var/backups/feedback
#   APP_DIR=/srv/feedback bash deploy/backup.sh   другой каталог приложения
#   BACKUP_DIR=/mnt/nas/feedback bash deploy/backup.sh   другое хранилище
#
# Хранятся последние 14 копий; ставится в cron deploy/vps-setup.sh:
#   0 3 * * * root APP_DIR=/opt/feedback /usr/local/bin/feedback-backup
#
# Раз в неделю копируйте хотя бы одну копию к себе (база лежит на том же диске, что и сервер):
#   scp root@СЕРВЕР:/var/backups/feedback/feedback-$(date +%F).sqlite.gz ./
#
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/feedback}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/feedback}"
KEEP="${KEEP:-14}"

# путь к базе берём из .env, чтобы скрипт не разъезжался с настройками службы
DB_FILE=""
if [ -f "$APP_DIR/.env" ]; then
  DB_FILE="$(sed -n 's/^[[:space:]]*DB_FILE=//p' "$APP_DIR/.env" | tail -n 1 | tr -d '\r' | sed "s/^['\"]//; s/['\"]$//")"
fi
[ -n "$DB_FILE" ] || DB_FILE="$APP_DIR/data/feedback.sqlite"

if [ ! -f "$DB_FILE" ]; then
  echo "нет базы данных: $DB_FILE - копия не сделана"
  exit 0
fi

mkdir -p "$BACKUP_DIR"
stamp="$(date +%Y-%m-%d_%H-%M-%S)"
out="$BACKUP_DIR/feedback-$stamp.sqlite"

if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "на сервере нет sqlite3 - копия делается только им (apt-get install -y sqlite3)"
  exit 1
fi
sqlite3 "$DB_FILE" ".backup '$out'"

gzip -f "$out"
# проверка, что копия читается: если sqlite не открывает файл, копия негодна
gunzip -c "$out.gz" > "$out.check"
if ! sqlite3 "$out.check" "PRAGMA integrity_check;" | grep -q '^ok$'; then
  rm -f "$out.check"
  echo "ПРОВЕРКА НЕ ПРОЙДЕНА: $out.gz повреждён"
  exit 1
fi
rm -f "$out.check"

# старые копии: удаляем всё, что старше KEEP штук
ls -1t "$BACKUP_DIR"/feedback-*.sqlite.gz 2>/dev/null | tail -n "+$((KEEP + 1))" | while read -r old; do
  rm -f "$old"
done

echo "копия: $out.gz ($(du -h "$out.gz" | cut -f1))"
