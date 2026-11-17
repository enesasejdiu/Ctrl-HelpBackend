#!/usr/bin/env bash
# End-to-end check of the local staging stack (docs/staging-check.md has the results; docs/DEPLOY.md the real thing).
# Run from deploy/ after:
#   ./make-env.sh staging.env --staging
#   docker compose -p ticketflow-staging --env-file staging.env \
#     -f docker-compose.yml -f docker-compose.https.caddy.yml -f docker-compose.staging.yml up --build -d --wait
# then: ./staging-check.sh            (prints one line per check: PASS / FAIL, and exits 1 if any failed)
#
# Everything goes through https://ticketflow.localhost:8443 (Caddy → nginx → API), with Caddy's own root certificate
# (never curl -k). Emails are read from the Mailpit test inbox. It only ever talks to the ticketflow-staging project.
set -uo pipefail

cd "$(dirname "$0")" || exit 1
ENV_FILE=${ENV_FILE:-staging.env}
PROJECT=${PROJECT:-ticketflow-staging}
ORIGIN=$(grep -E '^CLIENT_URL=' "$ENV_FILE" | cut -d= -f2-)
MAILPIT=http://127.0.0.1:$(grep -E '^MAILPIT_PORT=' "$ENV_FILE" | cut -d= -f2- || true)
[[ $MAILPIT == http://127.0.0.1: ]] && MAILPIT=http://127.0.0.1:8025
API=$ORIGIN/api
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
COMPOSE_FILES=(-f docker-compose.yml -f docker-compose.https.caddy.yml -f docker-compose.staging.yml)
dc() { docker compose -p "$PROJECT" --env-file "$ENV_FILE" "${COMPOSE_FILES[@]}" "$@"; }

FAILED=0
pass() { echo "PASS  $*"; }
fail() {
  echo "FAIL  $*"
  FAILED=1
}
check() { # check "<description>" <command...>
  local what=$1
  shift
  if "$@"; then pass "$what"; else fail "$what"; fi
}
json() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s);const r=(new Function("v","return "+process.argv[1]))(v);console.log(typeof r==="object"?JSON.stringify(r):r)})' "$1"; }

# ---- HTTPS, as a browser would: a cookie jar per person, the CSRF cookie echoed in X-CSRF-Token ----
dc cp caddy:/data/caddy/pki/authorities/local/root.crt "$WORK/root.crt" >/dev/null 2>&1
CA=(--cacert "$WORK/root.crt")
jar() { echo "$WORK/$1.cookies"; }
csrf() { awk '$6=="tf_csrf"{print $7}' "$(jar "$1")" 2>/dev/null; }
# call <who> <METHOD> <path> [json body] → body in $WORK/out, status in $STATUS, headers in $WORK/headers
call() {
  local who=$1 method=$2 path=$3 body=${4:-}
  local args=("${CA[@]}" -s -o "$WORK/out" -D "$WORK/headers" -w '%{http_code}' -X "$method" -b "$(jar "$who")" -c "$(jar "$who")")
  [[ $method == GET ]] || args+=(-H "X-CSRF-Token: $(csrf "$who")")
  [[ -n $body ]] && args+=(-H 'Content-Type: application/json' --data "$body")
  STATUS=$(curl "${args[@]}" "$API/$path")
}
out() { cat "$WORK/out"; }
login() { call "$1" POST auth/login "{\"email\":\"$2\",\"password\":\"$3\"}"; }

# The newest set-password link Mailpit received for an address
link_for() {
  local email=$1 id
  for _ in $(seq 1 20); do
    id=$(curl -s "$MAILPIT/api/v1/search?query=to:%22$email%22" | json 'v.messages?.[0]?.ID ?? ""')
    [[ -n $id ]] && break
    sleep 0.5
  done
  [[ -n $id ]] || return 1
  curl -s "$MAILPIT/api/v1/message/$id" | json 'v.Text' | grep -o -E 'https://[^ ]+/set-password\?token=[A-Za-z0-9_-]+' | head -n 1
}
# Creates an account as <creator> and sets its password with the emailed link; prints the new id
make_account() { # make_account <creator> <name> <email> <role> <password>
  local creator=$1 name=$2 email=$3 role=$4 password=$5 link token
  call "$creator" POST users "{\"name\":\"$name\",\"email\":\"$email\"${role:+,\"role\":\"$role\"}}"
  [[ $STATUS == 201 ]] || return 1
  out | json 'v.user.id' >"$WORK/id"
  link=$(link_for "$email") || return 1
  token=${link##*token=}
  call anon POST auth/set-password "{\"token\":\"$token\",\"new_password\":\"$password\"}"
  [[ $STATUS == 200 ]] || return 1
  cat "$WORK/id"
}

STAMP=$(date +%s)
PW='Staging-Check-Pass-2026!'
echo "Staging check of $ORIGIN ($(date '+%Y-%m-%d %H:%M %Z'))"

# ---- 1. services, migrations, logs ----
check "all services running (db, api, web healthy; caddy, backup, mailpit up)" \
  bash -c "[[ \$(docker compose -p $PROJECT --env-file $ENV_FILE ${COMPOSE_FILES[*]} ps --format '{{.Service}} {{.State}} {{.Health}}' | grep -c -E '^(db|api|web) running healthy|^(caddy|backup|mailpit) running') == 6 ]]"
MIGRATIONS=$(find ../migrations -maxdepth 1 -name '*.sql' | wc -l | tr -d ' ')
check "api logs: migrations ran (all $MIGRATIONS applied / up to date)" bash -c "docker compose -p $PROJECT --env-file $ENV_FILE ${COMPOSE_FILES[*]} logs api 2>&1 | grep -q -E 'migrations applied: $MIGRATIONS'"
curl "${CA[@]}" -s -o /dev/null "$API/no-such-route"
check "api logs: JSON lines with request ids" bash -c "docker compose -p $PROJECT --env-file $ENV_FILE ${COMPOSE_FILES[*]} logs --no-log-prefix api 2>&1 | grep '^{' | grep -q '\"request_id\":\"'"

# ---- 2. first admin, HTTPS login, cookies, CSRF ----
ADMIN_EMAIL="admin.$STAMP@staging.test"
ADMIN_OUT=$(dc run --rm -T api npm run create-admin -- --name "Staging Admin" --email "$ADMIN_EMAIL" 2>/dev/null)
# With email set up it prints a set-password link (on the next line), otherwise a temporary password
TEMP=$(grep -o -E 'https://[^ ]+/set-password\?token=[A-Za-z0-9_-]+' <<<"$ADMIN_OUT" ||
  sed -n -E 's/^Temporary password[^:]*: *//p' <<<"$ADMIN_OUT")
check "create-admin made the first admin" test -n "$TEMP"
if [[ $TEMP == https://* ]]; then # email is on: the admin gets a set-password link instead of a temporary password
  call anon POST auth/set-password "{\"token\":\"${TEMP##*token=}\",\"new_password\":\"$PW\"}"
  login admin "$ADMIN_EMAIL" "$PW"
else
  login admin "$ADMIN_EMAIL" "$TEMP"
  call admin POST auth/change-password "{\"currentPassword\":\"$TEMP\",\"newPassword\":\"$PW\"}"
fi
check "admin logs in over HTTPS" test "$STATUS" = 200
login admin "$ADMIN_EMAIL" "$PW"
SESSION_COOKIE=$(grep -i '^set-cookie: tf_session=' "$WORK/headers")
CSRF_COOKIE=$(grep -i '^set-cookie: tf_csrf=' "$WORK/headers")
check "tf_session cookie: Secure, HttpOnly, SameSite" bash -c "grep -qi 'secure' <<<\"$SESSION_COOKIE\" && grep -qi 'httponly' <<<\"$SESSION_COOKIE\" && grep -qi 'samesite' <<<\"$SESSION_COOKIE\""
check "tf_csrf cookie: Secure, readable by the page (not HttpOnly)" bash -c "grep -qi 'secure' <<<\"$CSRF_COOKIE\" && ! grep -qi 'httponly' <<<\"$CSRF_COOKIE\""
STATUS=$(curl "${CA[@]}" -s -o "$WORK/out" -w '%{http_code}' -X POST -b "$(jar admin)" -H 'Content-Type: application/json' \
  --data '{"title":"x","description":"no csrf header","category_id":1}' "$API/tickets")
check "a change without the CSRF header is refused (403 CSRF_INVALID)" bash -c "[[ $STATUS == 403 ]] && grep -q CSRF_INVALID '$WORK/out'"

# ---- 3. the whole flow: HR → employee → ticket + attachment → assign → resolve → close → rate ----
HR_ID=$(make_account admin "Staging HR" "hr.$STAMP@staging.test" hr "$PW")
check "admin creates an HR user; HR sets a password with the emailed link" test -n "$HR_ID"
login hr "hr.$STAMP@staging.test" "$PW"
EMP_EMAIL="employee.$STAMP@staging.test"
EMP_ID=$(make_account hr "Staging Employee" "$EMP_EMAIL" "" "$PW")
check "HR creates an employee; the employee sets a password with the emailed link" test -n "$EMP_ID"
AGENT_ID=$(make_account admin "Staging Agent" "agent.$STAMP@staging.test" agent "$PW")
check "admin creates an agent" test -n "$AGENT_ID"
login employee "$EMP_EMAIL" "$PW"
check "the employee logs in" test "$STATUS" = 200
call employee GET meta
CATEGORY=$(out | json '(v.categories ?? v.data?.categories)[0].id')
call employee POST tickets "{\"title\":\"Printer on floor 2 ($STAMP)\",\"description\":\"Paper jam since this morning\",\"category_id\":$CATEGORY}"
TICKET=$(out | json 'v.id ?? v.ticket?.id')
check "the employee creates a ticket (#$TICKET)" test "$STATUS" = 201
for i in $(seq 1 3000); do echo "$i printer log line"; done >"$WORK/printer.log"
STATUS=$(curl "${CA[@]}" -s -o "$WORK/out" -w '%{http_code}' -b "$(jar employee)" -c "$(jar employee)" \
  -H "X-CSRF-Token: $(csrf employee)" -F "files=@$WORK/printer.log;type=text/plain" "$API/tickets/$TICKET/attachments")
ATTACHMENT=$(out | json '(Array.isArray(v) ? v : v.attachments ?? v.data)[0].id')
check "the employee attaches a file (attachment #$ATTACHMENT)" test "$STATUS" = 201
call admin PATCH "tickets/$TICKET/assign" "{\"assigned_to\":$AGENT_ID}"
check "admin assigns the ticket to the agent" bash -c "[[ $STATUS == 200 ]] && grep -q '\"assigned\"' '$WORK/out'"
login agent "agent.$STAMP@staging.test" "$PW"
call agent PATCH "tickets/$TICKET/status" '{"status":"in_progress"}'
call agent PATCH "tickets/$TICKET/status" '{"status":"resolved","resolution":"Cleared the jam and replaced the roller"}'
check "the agent resolves it" test "$STATUS" = 200
call employee PATCH "tickets/$TICKET/status" '{"status":"closed"}'
check "the employee closes it" test "$STATUS" = 200
call employee POST "tickets/$TICKET/rating" '{"stars":5,"comment":"Fast, thanks"}'
check "the employee rates it (5 stars)" bash -c "[[ $STATUS == 200 || $STATUS == 201 ]]"
call employee GET "attachments/$ATTACHMENT/download"
check "the attachment downloads, byte for byte" bash -c "[[ $STATUS == 200 ]] && cmp -s '$WORK/out' '$WORK/printer.log'"

# ---- 4. which client address the API sees (Caddy → nginx → API: TRUST_PROXY_HOPS=2) ----
last_login_ip() {
  call admin GET "audit?action=login_success&pageSize=1"
  out | json '(v.entries ?? v.data ?? v)[0]?.ip ?? ""'
}
login admin "$ADMIN_EMAIL" "$PW"
SEEN_IP=$(last_login_ip)
CADDY_IP=$(dc exec -T caddy sh -c "hostname -i" 2>/dev/null | tr -d '\r')
WEB_IP=$(dc exec -T web sh -c "hostname -i" 2>/dev/null | tr -d '\r')
check "the audit log has the client's address ($SEEN_IP), not Caddy's ($CADDY_IP) or nginx's ($WEB_IP)" \
  bash -c "[[ -n '$SEEN_IP' && '$SEEN_IP' != '$CADDY_IP' && '$SEEN_IP' != '$WEB_IP' ]]"
# A client that sends its own X-Forwarded-For can't pick its address: Caddy replaces the header with the real one
curl "${CA[@]}" -s -o /dev/null -c "$(jar admin)" -b "$(jar admin)" -H 'X-Forwarded-For: 203.0.113.66' \
  -H 'Content-Type: application/json' -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$PW\"}" "$API/auth/login"
FAKED_IP=$(last_login_ip)
check "a faked X-Forwarded-For: 203.0.113.66 is ignored (audit: $FAKED_IP)" test "$FAKED_IP" = "$SEEN_IP"
# The login limit counts per real address: 20 failed logins, each with a different faked address, then the 21st is 429
for i in $(seq 1 20); do
  curl "${CA[@]}" -s -o /dev/null -H "X-Forwarded-For: 198.51.100.$i" -H 'Content-Type: application/json' \
    -d '{"email":"nobody@staging.test","password":"wrong-password-1"}' "$API/auth/login"
done
STATUS=$(curl "${CA[@]}" -s -o /dev/null -w '%{http_code}' -H 'X-Forwarded-For: 198.51.100.99' \
  -H 'Content-Type: application/json' -d '{"email":"nobody@staging.test","password":"wrong-password-1"}' "$API/auth/login")
check "the login limit counts the real address: 20 failures with 20 faked addresses, the 21st gets 429" test "$STATUS" = 429
# Successful logins never counted, and the limit's counts live in memory: a restart clears them for the checks below
dc restart api >/dev/null 2>&1
dc up -d --wait api >/dev/null 2>&1
login admin "$ADMIN_EMAIL" "$PW"

# ---- 5. a 500 shows a reference that is in the logs ----
dc stop db >/dev/null 2>&1
call employee GET tickets
REFERENCE=$(out | json 'v.request_id ?? ""')
check "a 500 says \"Something went wrong (reference: <id>)\"" bash -c "[[ $STATUS == 500 ]] && grep -q 'Something went wrong (reference: $REFERENCE)' '$WORK/out'"
dc start db >/dev/null 2>&1
dc up -d --wait db >/dev/null 2>&1
check "that reference is in the api logs (error line with the stack)" bash -c "docker compose -p $PROJECT --env-file $ENV_FILE ${COMPOSE_FILES[*]} logs --no-log-prefix api 2>&1 | grep '$REFERENCE' | grep -q '\"level\":\"error\".*\"stack\"'"

# ---- 6. backups: backup-now, list, restore ----
BACKUP=$(dc run --rm -T backup backup-now 2>&1 | grep '\[backup\] ok')
check "backup-now: $(sed -E 's/.*\] //' <<<"$BACKUP" | cut -c1-110)" test -n "$BACKUP"
check "list shows it" bash -c "docker compose -p $PROJECT --env-file $ENV_FILE ${COMPOSE_FILES[*]} run --rm -T backup list 2>&1 | grep -q '$(grep -o -E 'ticketflow-[0-9-]+\.sql\.gz' <<<"$BACKUP")'"
DB_FILE=$(grep -o -E 'ticketflow-[0-9-]+\.sql\.gz' <<<"$BACKUP")
UP_FILE=$(grep -o -E 'ticketflow-uploads-[0-9-]+\.tar\.gz' <<<"$BACKUP")
call employee DELETE "attachments/$ATTACHMENT"
dc exec -T db sh -c "MYSQL_PWD=\"\$MYSQL_PASSWORD\" mysql -u \"\$MYSQL_USER\" \"\$MYSQL_DATABASE\" -e 'DELETE FROM tickets WHERE id=$TICKET'" 2>/dev/null
call employee GET "tickets/$TICKET"
check "after deleting: ticket and attachment gone (ticket $STATUS)" test "$STATUS" = 404
dc stop api >/dev/null 2>&1
check "restore (API stopped): database + attachments" bash -c "docker compose -p $PROJECT --env-file $ENV_FILE ${COMPOSE_FILES[*]} run --rm -T backup restore $DB_FILE --uploads $UP_FILE --yes 2>&1 | grep -q 'restore ok'"
dc up -d --wait api >/dev/null 2>&1
login employee "$EMP_EMAIL" "$PW"
call employee GET "tickets/$TICKET"
check "after the restore: the ticket is back" bash -c "[[ $STATUS == 200 ]] && grep -q 'Printer on floor 2' '$WORK/out'"
call employee GET "attachments/$ATTACHMENT/download"
check "after the restore: the attachment downloads, byte for byte" bash -c "[[ $STATUS == 200 ]] && cmp -s '$WORK/out' '$WORK/printer.log'"

# ---- 7. restart the whole stack ----
dc down >/dev/null 2>&1
dc up -d --wait >/dev/null 2>&1
login employee "$EMP_EMAIL" "$PW"
call employee GET "tickets/$TICKET"
check "after down + up: the ticket is still there" bash -c "[[ $STATUS == 200 ]] && grep -q 'Printer on floor 2' '$WORK/out'"
call employee GET "attachments/$ATTACHMENT/download"
check "after down + up: the attachment still downloads" bash -c "[[ $STATUS == 200 ]] && cmp -s '$WORK/out' '$WORK/printer.log'"
dc cp caddy:/data/caddy/pki/authorities/local/root.crt "$WORK/root2.crt" >/dev/null 2>&1
check "after down + up: the same certificate authority (caddy_data kept)" cmp -s "$WORK/root.crt" "$WORK/root2.crt"

# ---- 8. HTTPS details ----
HEADERS=$(curl "${CA[@]}" -s -D - -o /dev/null "$ORIGIN/")
for header in 'strict-transport-security: max-age=' 'x-content-type-options: nosniff' 'x-frame-options: deny' 'content-security-policy: '; do
  check "page header: $header" grep -qi "^$header" <<<"$HEADERS"
done
check "no Server header" bash -c "! grep -qi '^server:' <<<\"$HEADERS\""
API_HEADERS=$(curl "${CA[@]}" -s -D - -o /dev/null "$API/health" | tr -d '\r' | tr '[:upper:]' '[:lower:]')
for header in x-content-type-options x-frame-options content-security-policy strict-transport-security; do
  check "/api answers: $header exactly once" test "$(grep -c "^$header:" <<<"$API_HEADERS")" = 1
done
HTTP_ORIGIN=$(sed -E 's#^https://([^:/]+).*#http://\1#' <<<"$ORIGIN"):${STAGING_HTTP_PORT:-8880}
REDIRECT=$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' "$HTTP_ORIGIN/tickets?page=2")
check "http:// redirects to https:// ($REDIRECT)" bash -c "[[ '$REDIRECT' == '301 $ORIGIN/tickets?page=2' || '$REDIRECT' == '308 $ORIGIN/tickets?page=2' ]]"
check "the certificate is valid for the name (verified against Caddy's root)" bash -c "curl ${CA[*]} -s -o /dev/null '$ORIGIN/'"
check "a page refresh on /tickets works (SPA)" bash -c "[[ \$(curl ${CA[*]} -s -o /dev/null -w '%{http_code}' '$ORIGIN/tickets') == 200 ]]"

echo
((FAILED)) && echo "Some checks FAILED" || echo "All checks passed"
exit "$FAILED"
