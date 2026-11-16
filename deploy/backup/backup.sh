#!/usr/bin/env bash
# The backup service of deploy/docker-compose.yml (README "Backups"). Commands:
#
#   serve                       (the default) once a day at BACKUP_TIME (TZ), run a backup; log one line per run
#   backup-now                  run a backup now: docker compose run --rm backup backup-now
#   list                        list the backups:  docker compose run --rm backup list
#   restore <file> [--uploads <file>] [--yes]
#                               restore the database from <file> and, if given, the attachments from the uploads
#                               archive. Asks for confirmation (or --yes). Stop the API first (docker compose stop api).
#
# A backup is two files in /backups (the ticketflow_backups volume):
#   ticketflow-<YYYY-MM-DD-HHmm>.sql.gz           mysqldump --single-transaction of the database, as BACKUP_USER, a
#                                                 MySQL user that can only read (deploy/mysql/backup-user.sh)
#   ticketflow-uploads-<YYYY-MM-DD-HHmm>.tar.gz   the attachment files (the ticketflow_uploads volume)
# Each is written under a hidden temporary name (.<name>.partial), checked (gzip -t), and only then renamed: a dump that
# is killed halfway never looks like a backup, and the next run removes the leftover. After a run in which both
# succeeded, only the newest BACKUP_KEEP of each kind are kept. db:migrate's own backups (*.sql) are never touched.
# The *_PATTERN globs are expanded on purpose (unquoted); every file name in /backups is one this script made, so
# there are no spaces or newlines to split on.
# shellcheck disable=SC2086,SC2045,SC2012,SC2231
set -uo pipefail

BACKUP_DIR=${BACKUP_DIR:-/backups}
UPLOADS_DIR=${UPLOADS_DIR:-/uploads}
BACKUP_TIME=${BACKUP_TIME:-02:30}
BACKUP_KEEP=${BACKUP_KEEP:-14}
DB_HOST=${DB_HOST:-db}
DB_PORT=${DB_PORT:-3306}
DB_NAME=${DB_NAME:-ticketflow}

DB_PATTERN='ticketflow-[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]-[0-9][0-9][0-9][0-9]*.sql.gz'
UPLOADS_PATTERN='ticketflow-uploads-[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]-[0-9][0-9][0-9][0-9]*.tar.gz'

now() { date '+%Y-%m-%dT%H:%M:%S%z'; }
log() { echo "$(now) [backup] $*"; }
fail() {
  echo "$(now) [backup] ERROR: $*" >&2
  exit 1
}
human() { numfmt --to=iec --suffix=B "$(stat -c %s "$1")"; }

check_settings() {
  [[ $BACKUP_TIME =~ ^([01][0-9]|2[0-3]):[0-5][0-9]$ ]] || fail "BACKUP_TIME must be HH:MM (24 h), got \"$BACKUP_TIME\""
  [[ $BACKUP_KEEP =~ ^[1-9][0-9]*$ ]] || fail "BACKUP_KEEP must be a whole number of 1 or more, got \"$BACKUP_KEEP\""
}

# ---- backup ----

# The name for this run: ticketflow-2026-11-16-0230.sql.gz. A second run in the same minute (backup-now) gets -2, the
# next -3, ...: always one more than the highest still there, so a newer backup never reuses an older (pruned) name.
free_name() {
  local prefix=$1 stamp=$2 ext=$3 file n highest=0
  for file in "$BACKUP_DIR/$prefix-$stamp".$ext "$BACKUP_DIR/$prefix-$stamp"-*.$ext; do
    [[ -e $file ]] || continue
    n=${file#"$BACKUP_DIR/$prefix-$stamp"}
    n=${n%."$ext"}
    n=${n#-}
    [[ -z $n ]] && n=1
    [[ $n =~ ^[0-9]+$ ]] && ((n > highest)) && highest=$n
  done
  if ((highest == 0)); then
    echo "$prefix-$stamp.$ext"
  else
    echo "$prefix-$stamp-$((highest + 1)).$ext"
  fi
}

# Newest first (by modification time); keeps the first BACKUP_KEEP matching $1, deletes the rest
prune() {
  local pattern=$1 file
  ls -1t "$BACKUP_DIR"/$pattern 2>/dev/null | tail -n +$((BACKUP_KEEP + 1)) | while read -r file; do
    rm -f -- "$file"
  done
}

count() {
  ls -1 "$BACKUP_DIR"/$1 2>/dev/null | wc -l
}

# One run: the database and the uploads. Prints one line, "ok" or "FAILED"; returns 1 on failure.
run_backup() {
  check_settings
  local stamp db_name up_name db_tmp up_tmp err problems=()
  stamp=$(date +%Y-%m-%d-%H%M)
  db_name=$(free_name ticketflow "$stamp" sql.gz)
  up_name=$(free_name ticketflow-uploads "$stamp" tar.gz)
  db_tmp="$BACKUP_DIR/.$db_name.partial"
  up_tmp="$BACKUP_DIR/.$up_name.partial"
  err=$(mktemp)
  # A run killed earlier (container stopped mid-dump) left a partial file: never a backup, remove it
  rm -f "$BACKUP_DIR"/.*.partial
  # Stopped now (docker stop, Ctrl+C): remove this run's partial files on the way out
  trap 'rm -f "$db_tmp" "$up_tmp" "$err"; exit 143' TERM INT

  # The database, as the read-only backup user; the password goes through the environment, not the command line
  if MYSQL_PWD=$BACKUP_PASSWORD mysqldump --host="$DB_HOST" --port="$DB_PORT" --user="$BACKUP_USER" \
    --single-transaction --no-tablespaces --set-gtid-purged=OFF --skip-routines --skip-events \
    "$DB_NAME" 2>"$err" | gzip -6 >"$db_tmp" && gzip -t "$db_tmp" 2>>"$err" && [[ -s $db_tmp ]]; then
    mv "$db_tmp" "$BACKUP_DIR/$db_name"
  else
    rm -f "$db_tmp"
    problems+=("database: $(grep -v -i 'Using a password' "$err" | head -n 1 | tr -d '\r')")
  fi

  # The attachment files
  if tar -czf "$up_tmp" -C "$UPLOADS_DIR" . 2>"$err" && gzip -t "$up_tmp" 2>>"$err"; then
    mv "$up_tmp" "$BACKUP_DIR/$up_name"
  else
    rm -f "$up_tmp"
    problems+=("uploads: $(head -n 1 "$err" | tr -d '\r')")
  fi
  rm -f "$err"
  trap - TERM INT

  if ((${#problems[@]} > 0)); then
    # The newer half of a failed run stays, but nothing older is deleted: a failure never costs a good backup
    log "FAILED $(
      IFS=';'
      echo "${problems[*]}"
    ) | kept so far: $(count "$DB_PATTERN") database, $(count "$UPLOADS_PATTERN") uploads backups"
    return 1
  fi
  prune "$DB_PATTERN"
  prune "$UPLOADS_PATTERN"
  log "ok $db_name ($(human "$BACKUP_DIR/$db_name")) $up_name ($(human "$BACKUP_DIR/$up_name"))" \
    "| keeping $(count "$DB_PATTERN") database and $(count "$UPLOADS_PATTERN") uploads backups (BACKUP_KEEP=$BACKUP_KEEP)"
}

# Seconds until the next BACKUP_TIME in the container's time zone (TZ); today's if it is still ahead, else tomorrow's.
# Worked out again before every wait, so daylight saving changes are followed.
seconds_until_next_run() {
  local now_s next_s
  now_s=$(date +%s)
  next_s=$(date -d "today $BACKUP_TIME" +%s)
  ((next_s <= now_s)) && next_s=$(date -d "tomorrow $BACKUP_TIME" +%s)
  echo $((next_s - now_s))
}

serve() {
  check_settings
  [[ -n ${BACKUP_PASSWORD:-} ]] || fail "BACKUP_PASSWORD is not set (deploy/.env)"
  log "daily backups at $BACKUP_TIME ($(date +%Z), TZ=${TZ:-UTC}), keeping the newest $BACKUP_KEEP of each kind"
  local seconds
  while true; do
    trap 'log "stopping"; exit 0' TERM INT # (run_backup sets its own while it runs)
    seconds=$(seconds_until_next_run)
    log "next run at $(date -d "@$(($(date +%s) + seconds))" '+%Y-%m-%d %H:%M %Z')"
    # In the background, so docker stop's SIGTERM is handled straight away instead of after the sleep
    sleep "$seconds" &
    wait $!
    run_backup || true # a failed run is logged ("FAILED"); the schedule goes on
  done
}

# ---- list ----

list() {
  local kind pattern file found
  for kind in database uploads; do
    [[ $kind == database ]] && pattern=$DB_PATTERN || pattern=$UPLOADS_PATTERN
    echo "$kind backups (newest first):"
    found=0
      for file in $(ls -1t "$BACKUP_DIR"/$pattern 2>/dev/null); do
      printf '  %-48s %8s  %s\n' "$(basename "$file")" "$(human "$file")" "$(date -r "$file" '+%Y-%m-%d %H:%M %Z')"
      found=1
    done
    ((found)) || echo "  (none)"
  done
}

# ---- restore ----

# A file name in /backups, or a path
backup_file() {
  local name=$1
  [[ $name == */* ]] || name="$BACKUP_DIR/$name"
  [[ -f $name ]] || fail "no such backup: $1 (see: docker compose run --rm backup list)"
  echo "$name"
}

api_running() {
  # bash can open a TCP connection itself; the API answers on api:5050 while it runs
  (exec 3<>/dev/tcp/api/5050) 2>/dev/null
}

restore() {
  local db_file="" up_file="" yes=0
  while (($# > 0)); do
    case $1 in
      --uploads)
        [[ $# -ge 2 ]] || fail "--uploads needs a file"
        up_file=$2
        shift 2
        ;;
      --yes) yes=1 && shift ;;
      -*) fail "unknown option $1" ;;
      *)
        [[ -z $db_file ]] || fail "only one database backup can be restored"
        db_file=$1
        shift
        ;;
    esac
  done
  [[ -n $db_file ]] || fail "usage: restore <ticketflow-...sql.gz> [--uploads <ticketflow-uploads-...tar.gz>] [--yes]"
  db_file=$(backup_file "$db_file") || exit 1
  [[ -z $up_file ]] || up_file=$(backup_file "$up_file") || exit 1
  [[ -n ${DB_USER:-} && -n ${DB_PASSWORD:-} ]] || fail "DB_USER and DB_PASSWORD (the app user) are needed to restore"

  # Damaged files are found before anything is changed
  gzip -t "$db_file" 2>/dev/null || fail "$(basename "$db_file") is damaged (gzip -t failed); nothing was changed"
  if [[ -n $up_file ]]; then
    tar -tzf "$up_file" >/dev/null 2>&1 || fail "$(basename "$up_file") is damaged; nothing was changed"
  fi

  echo "Restore into the database \"$DB_NAME\" on $DB_HOST:"
  echo "  database:    $(basename "$db_file") ($(human "$db_file"))"
  if [[ -n $up_file ]]; then
    echo "  attachments: $(basename "$up_file") ($(human "$up_file")); the current files in the uploads volume are replaced"
  else
    echo "  attachments: not restored (add --uploads <ticketflow-uploads-...tar.gz> to restore them too)"
  fi
  echo "The tables in the backup replace the current ones: tickets, users and comments made after the backup are lost."
  echo "Stop the API first, so nobody works on the database meanwhile:  docker compose stop api"
  echo "Afterwards start it again:                                     docker compose start api"
  if api_running; then
    fail "the API is still running. Stop it first: docker compose stop api (nothing was changed)"
  fi
  if ((!yes)); then
    [[ -t 0 ]] || fail "not a terminal: add --yes to restore without the question (nothing was changed)"
    local answer
    read -r -p "Type RESTORE to continue: " answer
    [[ $answer == RESTORE ]] || fail "not confirmed; nothing was changed"
  fi

  log "restoring database from $(basename "$db_file")"
  if ! gunzip -c "$db_file" | MYSQL_PWD=$DB_PASSWORD mysql --host="$DB_HOST" --port="$DB_PORT" --user="$DB_USER" \
    "$DB_NAME"; then
    fail "restoring the database failed (see above); start again from a backup once the cause is fixed"
  fi
  if [[ -n $up_file ]]; then
    log "restoring attachments from $(basename "$up_file")"
    find "$UPLOADS_DIR" -mindepth 1 -delete || fail "could not empty $UPLOADS_DIR"
    tar -xzf "$up_file" -C "$UPLOADS_DIR" || fail "unpacking $(basename "$up_file") failed"
  fi
  log "restore ok: $(basename "$db_file")${up_file:+ and $(basename "$up_file")}. Start the API again: docker compose start api"
}

case ${1:-serve} in
  serve) serve ;;
  backup-now) run_backup ;;
  list) list ;;
  restore)
    shift
    restore "$@"
    ;;
  *) fail "unknown command \"$1\": use serve, backup-now, list or restore <file> [--uploads <file>] [--yes]" ;;
esac
