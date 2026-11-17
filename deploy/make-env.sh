#!/usr/bin/env bash
# Writes a settings file for the Docker Compose setup with fresh secrets (docs/DEPLOY.md, docs/staging-check.md). It
# starts from deploy/.env.example and fills in:
#   - MYSQL_ROOT_PASSWORD, DB_PASSWORD, BACKUP_PASSWORD: 24 random bytes each (48 hex characters)
#   - JWT_SECRET: 48 random bytes (96 hex characters)
#   - CLIENT_URL / APP_URL https://<domain>, LOG_LEVEL=info, SENTRY_DSN empty
#   - for the HTTPS setup (docs/https.md, Caddy): DOMAIN, ACME_EMAIL, and COMPOSE_FILE so plain `docker compose` uses
#     docker-compose.yml and docker-compose.https.caddy.yml (which also sets TRUST_PROXY_HOPS=2 and hides web)
#
# Usage, from deploy/:
#   ./make-env.sh .env --domain helpdesk.example.com --email admin@example.com     a real server (Let's Encrypt)
#   ./make-env.sh staging.env --staging                                             the local staging stack
# --staging: DOMAIN=ticketflow.localhost:8443 (Caddy's local CA, ports 8880/8443: docker-compose.staging.yml), the app
# at https://ticketflow.localhost:8443, email to the Mailpit test inbox, SENTRY_ENVIRONMENT=staging.
#
# It never overwrites a file: delete it first if you really want new secrets (new DB passwords don't change the ones
# already inside an existing database volume). The file is readable only by you (chmod 600) and git-ignored.
set -euo pipefail

usage() {
  echo "usage: $0 <output file> (--domain <domain> --email <address> | --staging)" >&2
  exit 2
}

out=${1:-}
[[ -n $out && $out != --* ]] || usage
shift
domain=""
email=""
staging=0
while (($# > 0)); do
  case $1 in
    --domain)
      [[ $# -ge 2 ]] || usage
      domain=$2
      shift 2
      ;;
    --email)
      [[ $# -ge 2 ]] || usage
      email=$2
      shift 2
      ;;
    --staging)
      staging=1
      shift
      ;;
    *) usage ;;
  esac
done
origin_port="" # ":8443" for staging
if ((staging)); then
  domain=${domain:-ticketflow.localhost}
  origin_port=":8443"
  email=${email:-admin@example.com} # Caddy's local CA never uses it
fi
[[ -n $domain && -n $email ]] || usage
[[ $email == *@*.* ]] || {
  echo "not an email address: $email (Let's Encrypt sends certificate notices there)" >&2
  exit 2
}
[[ $domain =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] || {
  echo "not a domain name: $domain" >&2
  exit 2
}

here=$(cd "$(dirname "$0")" && pwd)
example="$here/.env.example"
[[ -f $example ]] || {
  echo "missing $example" >&2
  exit 1
}
if [[ -e $out ]]; then
  echo "$out already exists; not overwriting it (delete it first to start over)" >&2
  exit 1
fi
command -v openssl >/dev/null || {
  echo "openssl is needed to generate the secrets" >&2
  exit 1
}

hex() { openssl rand -hex "$1"; }

# The value for a key, generated once (bash 3.2 on macOS has no associative arrays, so a case statement and a list)
MYSQL_ROOT_PASSWORD=$(hex 24)
DB_PASSWORD=$(hex 24)
BACKUP_PASSWORD=$(hex 24)
JWT_SECRET=$(hex 48)
KEYS="MYSQL_ROOT_PASSWORD DB_PASSWORD BACKUP_PASSWORD JWT_SECRET CLIENT_URL APP_URL LOG_LEVEL SENTRY_DSN WEB_SENTRY_DSN DOMAIN ACME_EMAIL"
if ((staging)); then
  KEYS="$KEYS SENTRY_ENVIRONMENT MAIL_ENABLED SMTP_HOST SMTP_PORT SMTP_SECURE MAIL_FROM"
else
  KEYS="$KEYS COMPOSE_FILE"
fi
value_for() {
  case $1 in
    MYSQL_ROOT_PASSWORD) echo "$MYSQL_ROOT_PASSWORD" ;;
    DB_PASSWORD) echo "$DB_PASSWORD" ;;
    BACKUP_PASSWORD) echo "$BACKUP_PASSWORD" ;;
    JWT_SECRET) echo "$JWT_SECRET" ;;
    CLIENT_URL | APP_URL) echo "https://$domain$origin_port" ;;
    LOG_LEVEL) echo info ;;
    SENTRY_DSN | WEB_SENTRY_DSN) echo "" ;;
    DOMAIN) echo "$domain$origin_port" ;;
    ACME_EMAIL) echo "$email" ;;
    COMPOSE_FILE) echo docker-compose.yml:docker-compose.https.caddy.yml ;;
    SENTRY_ENVIRONMENT) echo staging ;;
    MAIL_ENABLED) echo true ;;
    SMTP_HOST) echo mailpit ;;
    SMTP_PORT) echo 1025 ;;
    SMTP_SECURE) echo false ;;
    MAIL_FROM) echo '"TicketFlow Staging <no-reply@ticketflow.localhost>"' ;;
  esac
}
has_key() { [[ " $KEYS " == *" $1 "* ]]; }

umask 077
tmp=$(mktemp "$out.XXXXXX")
trap 'rm -f "$tmp"' EXIT
written=" "
{
  if ((staging)); then
    echo "# Staging settings, made by deploy/make-env.sh --staging on $(date '+%Y-%m-%d %H:%M'). Disposable test stack."
  else
    echo "# Settings for $domain, made by deploy/make-env.sh on $(date '+%Y-%m-%d %H:%M'). Keep this file private."
  fi
  while IFS= read -r line || [[ -n $line ]]; do
    key=${line%%=*}
    key=${key#\# } # "# DOMAIN=..." in the example: a commented-out setting, filled in place when this script sets it
    if [[ $line =~ ^(\#\ )?[A-Z_]+= ]] && has_key "$key" && [[ $written != *" $key "* ]]; then
      echo "$key=$(value_for "$key")"
      written="$written$key "
    else
      echo "$line"
    fi
  done <"$example"
  extra=""
  for key in $KEYS; do
    [[ $written == *" $key "* ]] || extra="$extra $key"
  done
  if [[ -n $extra ]]; then
    echo
    echo "# --- Set by make-env.sh ---"
    for key in $extra; do
      echo "$key=$(value_for "$key")"
    done
  fi
} >"$tmp"
chmod 600 "$tmp"
mv "$tmp" "$out"
trap - EXIT
echo "Wrote $out (secrets generated; readable only by you). Site: https://$domain$origin_port"
