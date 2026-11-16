#!/usr/bin/env bash
# Checks a TicketFlow site behind the HTTPS proxy (docs/https.md, "Checks"). Run it after setting up Caddy or nginx +
# certbot, from any machine with curl (and jq, for the login checks):
#
#   deploy/check-https.sh tickets.example.com
#
# Optional settings (environment variables):
#   LOGIN_EMAIL, LOGIN_PASSWORD   an admin to log in as: adds the cookie, audit-log IP and upload checks (the upload
#                                 adds a 10 MB text file to the newest ticket; delete it afterwards on a real site)
#   HSTS_MAX_AGE                  the max-age to expect (default 300)
#   RESOLVE=127.0.0.1             send the requests to this address instead of the DNS answer (testing on the server)
#   INSECURE=1                    accept a certificate that isn't publicly trusted (a local or staging certificate)
#   PROXY_CONTAINER, WEB_CONTAINER   their names, to check that the API doesn't see their address as the visitor's
# CI runs it against both examples with local certificates (.github/workflows/ci.yml, "HTTPS examples").
set -u
DOMAIN="${1:?the domain, e.g. tickets.example.com}"
HSTS="${HSTS_MAX_AGE:-300}"
CURL=(curl -s --max-time 30)
[ -n "${RESOLVE:-}" ] && CURL+=(--resolve "$DOMAIN:80:$RESOLVE" --resolve "$DOMAIN:443:$RESOLVE")
[ "${INSECURE:-}" = 1 ] && CURL+=(-k)
HTTPS="https://$DOMAIN"
failures=0
pass() { echo "  ok    $1"; }
fail() {
  echo "  FAIL  $1"
  failures=$((failures + 1))
}
check() {
  local what="$1"
  shift
  if "$@" >/dev/null 2>&1; then pass "$what"; else fail "$what"; fi
}
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
# Response headers of a request, names lower-cased
headers() { "${CURL[@]}" -o /dev/null -D - "$@" | tr -d '\r' | sed 's/^\([^:]*\):/\L\1:/'; }
status() { "${CURL[@]}" -o /dev/null -w '%{http_code}' "$@"; }

echo "HTTP → HTTPS"
headers "http://$DOMAIN/tickets/5?x=1" >"$TMP/http.h"
echo "    $(head -1 "$TMP/http.h")"
check "http:// is redirected permanently (301 or 308)" grep -qE '^HTTP/[0-9.]+ (301|308)' "$TMP/http.h"
check "to the same address on https://" grep -qx "location: https://$DOMAIN/tickets/5?x=1" "$TMP/http.h"

echo "HTTPS"
headers "$HTTPS/" >"$TMP/https.h"
echo "    $(head -1 "$TMP/https.h")"
check "https:// → 200" grep -qE '^HTTP/[0-9.]+ 200' "$TMP/https.h"
check "HSTS max-age=$HSTS" grep -qx "strict-transport-security: max-age=$HSTS" "$TMP/https.h"
check "deep link /tickets/5 → 200 (the app)" test "$(status "$HTTPS/tickets/5")" = 200
headers "$HTTPS/api/health" >"$TMP/api.h"
check "/api/health → 200 from the API" grep -qE '^HTTP/[0-9.]+ 200' "$TMP/api.h"
check "API answers carry one HSTS header, the proxy's" test "$(grep -c '^strict-transport-security:' "$TMP/api.h")" = 1
check "... with max-age=$HSTS (not the API's 180 days)" grep -qx "strict-transport-security: max-age=$HSTS" "$TMP/api.h"
check "TLS 1.0 is refused" sh -c "! ${CURL[*]} --tlsv1.0 --tls-max 1.0 -o /dev/null https://$DOMAIN/"
check "TLS 1.1 is refused" sh -c "! ${CURL[*]} --tlsv1.1 --tls-max 1.1 -o /dev/null https://$DOMAIN/"
check "TLS 1.2 works" "${CURL[@]}" --fail --tlsv1.2 --tls-max 1.2 -o /dev/null "$HTTPS/"
check "TLS 1.3 works" "${CURL[@]}" --fail --tlsv1.3 -o /dev/null "$HTTPS/"

if [ -n "${LOGIN_EMAIL:-}" ]; then
  echo "Logged in (as $LOGIN_EMAIL)"
  "${CURL[@]}" -D "$TMP/login.h" -o /dev/null -H 'Content-Type: application/json' \
    -d "$(jq -n --arg e "$LOGIN_EMAIL" --arg p "${LOGIN_PASSWORD:-}" '{email: $e, password: $p}')" "$HTTPS/api/auth/login"
  check "login → 200" grep -qE '^HTTP/[0-9.]+ 200' "$TMP/login.h"
  check "the session cookie is Secure and HttpOnly" sh -c "grep -i '^set-cookie: tf_session=' '$TMP/login.h' | grep -i 'secure' | grep -qi 'httponly'"
  check "the CSRF cookie is Secure" sh -c "grep -i '^set-cookie: tf_csrf=' '$TMP/login.h' | grep -qi 'secure'"
  SESSION="$(grep -i '^set-cookie: tf_session=' "$TMP/login.h" | sed 's/^[^:]*: //; s/;.*//' | tr -d '\r')"
  CSRF="$(grep -i '^set-cookie: tf_csrf=' "$TMP/login.h" | sed 's/^[^:]*: //; s/;.*//' | tr -d '\r')"
  COOKIES="$SESSION; $CSRF"
  check "/api/auth/me with the cookies" sh -c "${CURL[*]} -f -H 'Cookie: $COOKIES' '$HTTPS/api/auth/me' | grep -q '$LOGIN_EMAIL'"

  # The visitor's address as the API saw it (the login's audit entry): never one of the proxies'
  AUDIT_IP="$("${CURL[@]}" -H "Cookie: $COOKIES" "$HTTPS/api/audit?action=login_success&pageSize=1" | jq -r '.entries[0].ip')"
  echo "    the audit log has the login from $AUDIT_IP"
  check "the audit log has an address" test -n "$AUDIT_IP" -a "$AUDIT_IP" != null
  for container in ${PROXY_CONTAINER:-} ${WEB_CONTAINER:-}; do
    ips="$(docker inspect --format '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' "$container")"
    check "... not $container's ($ips)" sh -c "! echo ' $ips ' | grep -q ' $AUDIT_IP '"
  done

  TICKET="$("${CURL[@]}" -H "Cookie: $COOKIES" "$HTTPS/api/tickets?page=1&pageSize=1" | jq -r '.items[0].id')"
  upload() {
    "${CURL[@]}" -o "$TMP/upload.json" -w '%{http_code}' -H "Cookie: $COOKIES" -H "X-CSRF-Token: ${CSRF#tf_csrf=}" \
      -F "files=@$1;type=text/plain" "$HTTPS/api/tickets/$TICKET/attachments"
  }
  head -c 10000000 /dev/zero | tr '\0' 'a' >"$TMP/ten-mb.txt"
  check "a 10 MB attachment uploads through the proxy (ticket $TICKET)" test "$(upload "$TMP/ten-mb.txt")" = 201
  head -c $((12 * 1024 * 1024)) /dev/zero | tr '\0' 'a' >"$TMP/twelve-mb.txt"
  check "a 12 MB one is refused (413)" test "$(upload "$TMP/twelve-mb.txt")" = 413
fi

echo
if [ "$failures" -eq 0 ]; then
  echo "All checks passed."
else
  echo "$failures check(s) failed."
  exit 1
fi
