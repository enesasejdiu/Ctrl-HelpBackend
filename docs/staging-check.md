# Staging: the whole system in production mode, checked end to end

A local stack that behaves like a real install (`NODE_ENV=production`, HTTPS through Caddy, real email over SMTP,
daily backups), and the results of checking it from the outside. For a real server, follow [DEPLOY.md](DEPLOY.md);
HTTPS itself is [https.md](https.md).

Checked on 2026-11-17 on a Mac (Colima, Docker 29, Compose 5.7) with backend `main` at #67 (escalation; 21
migrations) and frontend `main` at #62.

## Bring it up (one command)

```bash
deploy/staging-up.sh            # asks before deleting an existing staging stack; --yes doesn't ask
deploy/staging-check.sh         # the checks below; PASS/FAIL per line, exit 1 if any failed
```

`staging-up.sh` recreates everything from scratch in a few minutes:

1. removes the old `ticketflow-staging` stack and **all its data** (`down -v`) and its `deploy/staging.env`;
2. writes a new `staging.env` with fresh secrets (`make-env.sh --staging`: a 48-byte `JWT_SECRET`, random database
   passwords, `LOG_LEVEL=info`, `SENTRY_DSN` empty, email to Mailpit);
3. builds and starts it: `docker-compose.yml` + Aulona's `docker-compose.https.caddy.yml` (Caddy, `TRUST_PROXY_HOPS=2`,
   web not published) + `docker-compose.staging.yml` (only what's different locally: Caddy on 8880/8443, a redirect that
   keeps the port, Mailpit);
4. creates the **E2E admin** (`e2e-admin@example.test`, role admin) with `create-admin` and the emailed set-password
   link (never SQL), with a 40-character random password stored only in `~/.ticketflow-staging-e2e-admin` (chmod 600);
5. saves Caddy's root certificate to `~/ticketflow-staging-caddy-root.crt`.

Then:

- **https://ticketflow.localhost:8443**: the app (http on **8880** redirects there). Ports 8880/8443 instead of 80/443
  so it never clashes with a web server already on the machine (on this Mac, XAMPP's Apache holds 80/443).
- **http://127.0.0.1:8025**: Mailpit, every email the API sends (any domain).
- Its own Compose project (`ticketflow-staging`) and volumes; the development database is never touched.

**In a browser**: Caddy signs with its own local CA, which the Mac doesn't know, and Caddy sends HSTS, so the browser
won't let you click past the warning. Trust that root once: `deploy/staging-up.sh --trust` (macOS asks for your
password), or `security add-trusted-cert -r trustRoot -k ~/Library/Keychains/login.keychain-db
~/ticketflow-staging-caddy-root.crt`, then quit and reopen the browser. Every new stack has a **new** root with the
**same name**: remove the old one first (`security delete-certificate -c "Caddy Local Authority - 2026 ECC Root"
~/Library/Keychains/login.keychain-db`), or Firefox fails every page with `SEC_ERROR_UNKNOWN` (a root of that name with
the wrong key).

**Tear down**: `docker compose -p ticketflow-staging --env-file deploy/staging.env -f deploy/docker-compose.yml -f
deploy/docker-compose.https.caddy.yml -f deploy/docker-compose.staging.yml down -v`, or just run `staging-up.sh` again
for a fresh one.

## Results: `deploy/staging-check.sh`, 45 of 45 passed

| Area                                                         | Checks                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Services                                                     | db, api, web healthy; caddy, backup, mailpit running                                                                                                                                                                                                                                                                                                                       |
| Logs                                                         | the API log shows all migrations (21); every line is JSON with a `request_id`                                                                                                                                                                                                                                                                                              |
| First admin                                                  | `create-admin` (email on: it prints a one-time set-password link); the admin logs in over HTTPS                                                                                                                                                                                                                                                                            |
| Cookies                                                      | `tf_session`: Secure, HttpOnly, SameSite. `tf_csrf`: Secure, readable by the page. A change without the `X-CSRF-Token` header → 403 `CSRF_INVALID`                                                                                                                                                                                                                         |
| The whole flow                                               | admin creates HR → HR sets a password from the email (Mailpit) → HR creates an employee → the employee sets a password from the email, logs in, creates a ticket and attaches a file → admin creates an agent and assigns the ticket → the agent sets it in progress, then resolved → the employee closes it and rates it 5 stars → the attachment downloads byte for byte |
| **Client address** (`TRUST_PROXY_HOPS=2`: Caddy → web → api) | the audit log records the client (172.18.0.1, the Mac), not Caddy (172.18.0.7) or nginx (172.18.0.6); a login with a faked `X-Forwarded-For: 203.0.113.66` is still recorded as 172.18.0.1; **20 failed logins, each with a different faked `X-Forwarded-For`, then the 21st gets 429**: the login limit counts the real address and can't be dodged                       |
| Errors                                                       | with the database stopped, the API answers `Something went wrong (reference: <id>)`; that id is in the API log on an `error` line with the stack                                                                                                                                                                                                                           |
| Backups                                                      | `backup-now` → both files; `list` shows them; the attachment and the ticket row deleted (404) → API stopped → `restore <db> --uploads <archive> --yes` → the ticket is back and the attachment downloads byte for byte                                                                                                                                                     |
| Restart                                                      | `down` + `up` (volumes kept): the ticket and the attachment are still there; the same certificate authority (Caddy's data volume kept)                                                                                                                                                                                                                                     |
| HTTPS                                                        | page headers: HSTS, `nosniff`, `X-Frame-Options: DENY`, a CSP; no `Server` header; `/api` answers carry each security header **once**; `http://…:8880/tickets?page=2` → `https://…:8443/tickets?page=2`; the certificate verifies against Caddy's root; a refresh on `/tickets` works                                                                                      |

## The frontend's Playwright suite against staging

`npm run e2e:deployed` in the frontend (`E2E_BASE_URL=https://ticketflow.localhost:8443`, emails from Mailpit, the
stack's certificate accepted), with staging reseeded before each browser (`docker compose … run --rm api node
scripts/seed.js --force`; staging is disposable):

| Browser  | Passed | Skipped | Failed |
| -------- | ------ | ------- | ------ |
| Chromium | 43     | 5       | 0      |
| Firefox  | 43     | 5       | 0      |

Skipped, because a production build can't do them: the 5 tests in `error-pages.spec.ts` (the `/__crash` pages exist
only in the dev server). "The lock runs out" doesn't run either (production always locks for 15 minutes).

**Production's login limit applies**: 20 failed logins per address per 15 minutes. The lockout tests alone make about
20 wrong logins on purpose, so each browser's run is split in three (everything else; the first three lockout tests;
the fourth), with the API restarted in between (its counts are in memory). Without the split every login after the
20th failure gets 429 for 15 minutes: the limit working, not a bug.

## Bugs found and fixed while setting staging up (each in its own PR)

| PR           | Bug                                                                                                                                                                                                | Fix                                                                       |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| backend #62  | Behind Caddy **and** nginx the API trusted only one proxy, so `req.ip` was Caddy's address for every user: one shared login limit for everyone, and the audit log showed the proxy, not the person | `TRUST_PROXY_HOPS` (default 1 = the web container; 2 with Caddy in front) |
| backend #63  | The per-address login limit counted **successful** logins too: 20 people signing in from one office address used it up, and the 21st got 429 with the right password                               | only failed attempts count; the per-account lockout is unchanged          |
| frontend #55 | nginx added the page's security headers to `/api` answers on top of the API's own: `X-Content-Type-Options: nosniff, nosniff`, two CSPs                                                            | the page's headers are not sent for `/api/`; the API's own arrive once    |

Found on the way, not bugs in the app: containers in Colima couldn't resolve DNS (builds that download packages
failed; fixed with `colima start --dns 1.1.1.1 --dns 8.8.8.8`), and a stale Caddy root in the macOS keychain broke
Firefox (above).
