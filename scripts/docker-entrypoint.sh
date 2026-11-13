#!/bin/sh
# Entrypoint of the API image (Dockerfile; README "Docker"). tini runs this script, which then becomes the command.
#
# Starting the server (the image's default command, node src/server.js): applies new migrations first
# (scripts/migrate.js, the same as npm run db:migrate). If that fails, the container stops with migrate's error and
# exit code instead of starting an API on an out-of-date database. MIGRATE_ON_START=false skips this step.
#
# Any other command (docker compose run --rm api npm run create-admin, node scripts/rollback.js, sh, ...) runs as it
# is, without migrating first: a rollback or a look around must not be blocked by a migration that fails.
set -eu

if [ "$*" = "node src/server.js" ] && [ "${MIGRATE_ON_START:-true}" != "false" ]; then
  echo "[entrypoint] Applying database migrations"
  if ! node scripts/migrate.js; then
    echo "[entrypoint] Migrations failed (see above): the API was not started" >&2
    exit 1
  fi
fi

# exec: the command replaces this shell, so docker stop's SIGTERM reaches Node directly (through tini)
exec "$@"
