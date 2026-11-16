#!/bin/sh
# Creates (or updates) the MySQL user the backup service dumps the database with (README "Backups"). It may only
# read: SELECT, SHOW VIEW and TRIGGER on the app's database (what mysqldump --single-transaction --no-tablespaces
# needs), nothing else.
#
# Runs by itself when the db volume is created (mounted into /docker-entrypoint-initdb.d). For a database that already
# exists, run it once (it is safe to run again, e.g. after changing BACKUP_PASSWORD in deploy/.env):
#   docker compose exec db sh /docker-entrypoint-initdb.d/20-backup-user.sh
set -eu

: "${BACKUP_USER:?Set BACKUP_USER in deploy/.env}"
: "${BACKUP_PASSWORD:?Set BACKUP_PASSWORD in deploy/.env}"
db=${MYSQL_DATABASE:?}

# Single quotes in the values are doubled, so they can't end the SQL string
quote() { printf "%s" "$1" | sed "s/'/''/g"; }
user=$(quote "$BACKUP_USER")
password=$(quote "$BACKUP_PASSWORD")

MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql --protocol=socket -uroot <<SQL
CREATE USER IF NOT EXISTS '$user'@'%' IDENTIFIED BY '$password';
ALTER USER '$user'@'%' IDENTIFIED BY '$password';
GRANT SELECT, SHOW VIEW, TRIGGER ON \`$db\`.* TO '$user'@'%';
SQL
echo "[backup-user] $BACKUP_USER can read (and dump) the $db database"
