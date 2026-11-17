#!/usr/bin/env bash
# Recreates the local staging stack from scratch in one command (docs/staging-check.md):
#   1. removes the old stack and ALL its data (down -v), and its staging.env
#   2. writes a new staging.env with fresh secrets (make-env.sh --staging)
#   3. builds and starts everything: https://ticketflow.localhost:8443 (Caddy's local CA), Mailpit on 127.0.0.1:8025
#   4. creates the E2E admin (e2e-admin@example.test, role admin) through create-admin and the emailed set-password
#      link (never SQL), with a long random password stored only in ~/.ticketflow-staging-e2e-admin (chmod 600)
#   5. saves Caddy's root certificate to ~/ticketflow-staging-caddy-root.crt, so a browser can be made to trust it
#
# Usage, from anywhere:  deploy/staging-up.sh            asks before deleting the old stack's data
#                        deploy/staging-up.sh --yes      doesn't ask
#                        deploy/staging-up.sh --trust    also trusts the new root certificate in this Mac's login
#                                                        keychain (macOS asks for your password)
# Only ever the "ticketflow-staging" Compose project on this machine: never a server, never the development database.
set -euo pipefail

cd "$(dirname "$0")"
PROJECT=ticketflow-staging
ENV_FILE=staging.env
FILES=(-f docker-compose.yml -f docker-compose.https.caddy.yml -f docker-compose.staging.yml)
ADMIN_EMAIL=e2e-admin@example.test
ADMIN_FILE=~/.ticketflow-staging-e2e-admin
ROOT_CERT=~/ticketflow-staging-caddy-root.crt
dc() { docker compose -p "$PROJECT" --env-file "$ENV_FILE" "${FILES[@]}" "$@"; }

yes=0
trust=0
for arg in "$@"; do
  case $arg in
    --yes) yes=1 ;;
    --trust) trust=1 ;;
    *)
      echo "usage: $0 [--yes] [--trust]" >&2
      exit 2
      ;;
  esac
done

# 1. The old stack and its data
if [[ -f $ENV_FILE ]] || docker volume ls -q | grep -q "^${PROJECT}_"; then
  if ((!yes)); then
    read -r -p "This deletes the staging stack and ALL its data (project $PROJECT). Type yes to go on: " answer
    [[ $answer == yes ]] || {
      echo "Nothing was changed."
      exit 1
    }
  fi
  if [[ -f $ENV_FILE ]]; then
    dc down -v --remove-orphans
  else
    docker compose -p "$PROJECT" down -v --remove-orphans
  fi
  rm -f "$ENV_FILE"
fi

# 2. Fresh settings
./make-env.sh "$ENV_FILE" --staging

# 3. Build and start
dc up --build -d --wait
dc cp caddy:/data/caddy/pki/authorities/local/root.crt "$ROOT_CERT" >/dev/null
CA=(--cacert "$ROOT_CERT")
ORIGIN=$(grep -E '^CLIENT_URL=' "$ENV_FILE" | cut -d= -f2-)

# 4. The E2E admin: create-admin prints a one-time set-password link (email is on, to Mailpit); it is used here
link=$(dc run --rm -T api npm run create-admin -- --name "E2E Admin" --email "$ADMIN_EMAIL" 2>/dev/null |
  grep -o -E 'https://[^ ]+/set-password\?token=[A-Za-z0-9_-]+')
[[ -n $link ]] || {
  echo "create-admin printed no set-password link" >&2
  exit 1
}
password=$(openssl rand -base64 36 | tr -d '/+=\n' | cut -c1-40)
status=$(curl "${CA[@]}" -s -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' \
  -d "{\"token\":\"${link##*token=}\",\"new_password\":\"$password\"}" "$ORIGIN/api/auth/set-password")
[[ $status == 200 ]] || {
  echo "setting the E2E admin's password failed ($status)" >&2
  exit 1
}
(
  umask 077
  printf 'STAGING_ADMIN_EMAIL=%s\nSTAGING_ADMIN_PASSWORD=%s\n' "$ADMIN_EMAIL" "$password" >"$ADMIN_FILE"
)
chmod 600 "$ADMIN_FILE"
status=$(curl "${CA[@]}" -s -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$password\"}" "$ORIGIN/api/auth/login")
[[ $status == 200 ]] || {
  echo "the E2E admin can't log in ($status)" >&2
  exit 1
}

# 5. The browser: a new stack has a new certificate authority
if ((trust)); then
  security add-trusted-cert -r trustRoot -k ~/Library/Keychains/login.keychain-db "$ROOT_CERT"
fi

echo
echo "Staging is up: $ORIGIN (http on :8880 redirects there); emails at http://127.0.0.1:8025"
echo "E2E admin: $ADMIN_EMAIL, password in $ADMIN_FILE (readable only by you)"
echo "Caddy's root certificate: $ROOT_CERT$( ((trust)) && echo ' (trusted in your login keychain)')"
((trust)) || echo "  A browser trusts the site once that certificate is trusted: run again with --trust, or see docs/staging-check.md"
echo "Check it: deploy/staging-check.sh"
