# HTTPS for TicketFlow

This guide puts TicketFlow on HTTPS with a free, automatically renewed Let's Encrypt certificate. There are two ways
to do it:

- **Option A: Caddy.** Recommended. Caddy gets the certificate, renews it and redirects HTTP to HTTPS on its own.
- **Option B: nginx + certbot.** For a server that already runs nginx, or that needs nginx's features.

Both work on top of the normal Docker Compose setup in [`deploy/`](../deploy) (README "Run with Docker Compose").
Every example uses placeholders: `tickets.example.com` for your domain and `admin@example.com` for your email. Never
commit a real domain, a real email, a certificate or a private key.

## How it fits together

```
Internet ──► HTTPS proxy: Caddy or nginx ──► web (nginx, port 8080) ──► /api ──► api (port 5050) ──► db
             ports 80 + 443                  serves the app             passes on
             the only public ports           not published              not published
```

- **The proxy** is the only container with public ports. Port 443 is HTTPS. Port 80 only redirects to HTTPS and
  answers Let's Encrypt's challenge.
- **`web`** is the frontend image. It serves the app and passes `/api/...` on to the API, so the page and the API
  share one origin and need no CORS. It keeps its own config, which is unchanged. The HTTPS Compose files only stop
  publishing its port 8080.
- **`api`** and **`db`** were never published.

The API runs with `NODE_ENV=production`. That gives you:

- **`Secure` cookies.** The session and CSRF cookies are `Secure`, `HttpOnly` (session) and `SameSite=Lax`. Browsers
  only send `Secure` cookies over HTTPS, so login only works once HTTPS does. The one exception is `http://localhost`.
- **HTTPS-only links.** `CLIENT_URL` must be `https://…`, and so must `APP_URL` when email is on; the API refuses to
  start otherwise.
- **Trusted proxies.** `TRUST_PROXY_HOPS` says how many proxies sit in front of the API, so it takes the visitor's
  real IP from `X-Forwarded-For` for the login limits, the lockout and the audit log. With an HTTPS proxy in front of
  `web` there are **2**. Both HTTPS Compose files set that.
- **No dependence on `X-Forwarded-Proto`.** The API never builds URLs from it and never redirects to HTTPS. The
  addresses in emails come from `APP_URL`. The `web` container passes `X-Forwarded-Proto: http` (its own view), and
  that's harmless.

## 1. Before you start

**A domain pointing at the server.** Create an `A` record (IPv4) and, if the server has IPv6, an `AAAA` record for
`tickets.example.com` with the server's public addresses. Check from your own machine that they have arrived:

```bash
dig +short A tickets.example.com      # must print the server's IPv4 address
dig +short AAAA tickets.example.com   # the IPv6 address, or nothing if you have no AAAA record
curl -s https://api.ipify.org         # run on the server: its public IPv4, to compare
```

DNS changes can take minutes to hours to reach everyone. Don't continue until `dig` shows the right address. Let's
Encrypt checks the domain from the internet, and a wrong answer means a failed attempt that counts against its rate
limits. An `AAAA` record that points somewhere else (or at a server with no IPv6 proxy) also fails, because Let's
Encrypt prefers IPv6. Either fix it or remove the record.

**Ports 80 and 443 open** from the internet to the server, in both places:

- **The server's firewall.** For example, with `ufw`: `sudo ufw allow 80/tcp && sudo ufw allow 443/tcp` (and
  `sudo ufw allow 443/udp` for HTTP/3 with Caddy).
- **Your cloud provider's firewall** (security group / network firewall), if there is one.

Port 80 must stay open even though everything is redirected to HTTPS: Let's Encrypt's challenge comes in on port 80.

**Docker and Docker Compose 2.24.4 or newer** (`docker compose version`), and TicketFlow set up as in README "Run with
Docker Compose": `deploy/.env` filled in and the app working on `http://localhost:8080`. If something else (like
Apache or an nginx from apt) already listens on 80 or 443, stop it or use Option B on that nginx.

## 2. Option A: Caddy (recommended)

Files:

- [`deploy/caddy/Caddyfile`](../deploy/caddy/Caddyfile): the site.
- [`deploy/docker-compose.https.caddy.yml`](../deploy/docker-compose.https.caddy.yml): the `caddy` service, its
  volumes, `web` no longer published, and `TRUST_PROXY_HOPS=2`.

The Caddyfile is short:

```caddyfile
{
	email {$ACME_EMAIL}
	acme_ca {$ACME_CA:https://acme-v02.api.letsencrypt.org/directory}
}

{$DOMAIN} {
	encode zstd gzip
	header {
		Strict-Transport-Security "max-age={$HSTS_MAX_AGE:300}"
		-Server
		-Via
	}
	request_body {
		max_size 11MB
	}
	reverse_proxy web:8080 {
		header_down -Strict-Transport-Security
	}
	log
}
```

What Caddy does here:

- **Certificates.** For `{$DOMAIN}` it gets a certificate from Let's Encrypt, renews it about 30 days before it
  expires, and redirects every `http://` request to `https://` (308).
- **Headers.** `reverse_proxy` passes `Host`, `X-Forwarded-For`, `X-Forwarded-Proto` and `X-Forwarded-Host` on by
  itself. The security headers of the page and the API come from the containers behind it. Caddy adds HSTS and drops
  the API's own HSTS (see "HSTS" below). It also removes `Server` and `Via` from the app's answers. Only its own HTTP →
  HTTPS redirect still says `Server: Caddy`.
- **Persistent volumes.** The certificates and the ACME account live in the `caddy-data` volume (`/data`). Without
  that volume, every `docker compose up` that recreates the container would request new certificates, and Let's
  Encrypt allows only 5 certificates for the same names per week. Don't delete the volume (`docker compose down -v`
  deletes it).

**Steps:**

1. Add to `deploy/.env` (with your values):

   ```bash
   DOMAIN=tickets.example.com
   ACME_EMAIL=admin@example.com
   # The first try against Let's Encrypt's staging CA: untrusted certificates, but generous limits
   ACME_CA=https://acme-staging-v02.api.letsencrypt.org/directory
   CLIENT_URL=https://tickets.example.com
   APP_URL=https://tickets.example.com
   COMPOSE_FILE=docker-compose.yml:docker-compose.https.caddy.yml
   ```

   `COMPOSE_FILE` makes every `docker compose` command in `deploy/` use both files. Without it, add
   `-f docker-compose.yml -f docker-compose.https.caddy.yml` to each command.

2. Start it, and watch Caddy get the certificate:

   ```bash
   cd deploy
   docker compose up -d --build
   docker compose logs -f caddy      # wait for "certificate obtained successfully", then Ctrl+C
   ```

3. Check with `curl -kI https://tickets.example.com`. You need `-k` because staging certificates aren't trusted.

4. Switch to the real CA. Remove the `ACME_CA=` line from `deploy/.env`, then `docker compose up -d`. Caddy keeps each
   CA's certificates apart, so it now gets a real one. Open `https://tickets.example.com` in a browser and check the
   padlock.

**A test without a public domain:** with `DOMAIN=localhost`, Caddy uses its own local CA instead of Let's Encrypt,
the same as `tls internal`. That's how CI tests this setup (see "Checks"). For an internal-only server that nobody
reaches from the internet, you can put `tls internal` in the site block. Browsers then warn until Caddy's root
certificate is installed on each machine.

## 3. Option B: nginx + certbot

Files:

- [`deploy/nginx/https.conf`](../deploy/nginx/https.conf): the site.
- [`deploy/docker-compose.https.nginx.yml`](../deploy/docker-compose.https.nginx.yml): the `proxy`, `certbot-renew`
  and `certbot` services and their volumes, `web` no longer published, and `TRUST_PROXY_HOPS=2`.

**First, put your domain into the config** (it has `tickets.example.com` in four places):

```bash
sed -i 's/tickets\.example\.com/helpdesk.example.org/g' deploy/nginx/https.conf   # your domain after the second /
```

What's in `https.conf`:

- **Port 80** serves `/.well-known/acme-challenge/` from `/var/www/certbot` (certbot's webroot) and redirects
  everything else with `301` to `https://`.
- **Port 443**, with `http2 on`:
  - the certificate from `/etc/letsencrypt/live/<domain>/` (`fullchain.pem`, `privkey.pem`);
  - TLS 1.2 and 1.3 only, with Mozilla's "intermediate" ciphers (without the DHE ones, so no dhparam file);
  - `ssl_session_cache shared:TLS:10m`, session tickets off;
  - HSTS, and `client_max_body_size 11m` for 10 MB attachments (nginx's default is 1 MB);
  - the proxy to `web:8080`, with `Host`, `X-Real-IP`, `X-Forwarded-For`, `X-Forwarded-Proto` and `X-Forwarded-Host`.

There's no OCSP stapling, because Let's Encrypt stopped running OCSP in 2025.

### Getting the first certificate (Docker Compose)

nginx won't start without the certificate files, and certbot needs a running nginx to answer the challenge. So the
first time, nginx starts with a temporary self-signed certificate, which certbot then replaces. Run these in `deploy/`,
with your domain and email:

```bash
cd deploy
export COMPOSE_FILE=docker-compose.yml:docker-compose.https.nginx.yml   # or put it in deploy/.env
D=tickets.example.com
E=admin@example.com

# 1. A temporary self-signed certificate (valid 1 day), so nginx can start
docker compose run --rm --entrypoint sh certbot -c "mkdir -p /etc/letsencrypt/live/$D && openssl req -x509 -nodes -newkey rsa:2048 -days 1 -subj /CN=$D -keyout /etc/letsencrypt/live/$D/privkey.pem -out /etc/letsencrypt/live/$D/fullchain.pem"

# 2. Start everything (the proxy now answers on 80 and 443)
docker compose up -d --build

# 3. Remove the temporary certificate (nginx keeps using it until the reload in step 4)
docker compose run --rm --entrypoint sh certbot -c "rm -rf /etc/letsencrypt/live/$D /etc/letsencrypt/archive/$D /etc/letsencrypt/renewal/$D.conf"

# 4. A STAGING certificate first (untrusted, but it shows that DNS, ports and the challenge work)
docker compose run --rm certbot certonly --webroot -w /var/www/certbot -d $D --email $E --agree-tos --no-eff-email --staging
docker compose exec proxy nginx -s reload

# 5. The real certificate, replacing the staging one
docker compose run --rm certbot certonly --webroot -w /var/www/certbot -d $D --email $E --agree-tos --no-eff-email --force-renewal
docker compose exec proxy nginx -s reload
```

**Renewal (Docker).**

- The `certbot-renew` service runs `certbot renew --webroot` twice a day. certbot only renews a certificate in its last
  30 days.
- The `proxy` service reloads nginx every 6 hours, which picks up the new files. A certbot container can't reload
  another container, so this replaces `--deploy-hook`.
- Check renewal at any time with a dry run, which uses the staging CA and changes nothing:

```bash
docker compose run --rm certbot renew --dry-run
```

### nginx and certbot on the server itself (apt)

This works the same way, except nginx and certbot run on the host (Debian or Ubuntu), and the TicketFlow containers
run with the normal `deploy/docker-compose.yml` only.

1. In `deploy/.env`, publish `web` on the loopback address only, and count the host's nginx as a proxy:

   ```bash
   WEB_PORT=127.0.0.1:8080
   TRUST_PROXY_HOPS=2
   CLIENT_URL=https://tickets.example.com
   APP_URL=https://tickets.example.com
   ```

   Then run `docker compose up -d --build` in `deploy/` (without `COMPOSE_FILE`).

2. Install, and put the site in place. With your domain already in `https.conf` (the `sed` above), point it at the
   web container's port on this host instead of the `web` service name, and remove Debian's default site, which
   would answer port 80 instead:

   ```bash
   sudo apt update && sudo apt install -y nginx certbot
   sudo mkdir -p /var/www/certbot
   sudo cp deploy/nginx/https.conf /etc/nginx/conf.d/ticketflow.conf
   sudo sed -i 's|http://web:8080;|http://127.0.0.1:8080;|' /etc/nginx/conf.d/ticketflow.conf
   sudo rm -f /etc/nginx/sites-enabled/default
   ```

3. The first certificate, the same way as with Docker (a temporary one, then staging, then the real one).
   `--deploy-hook` is saved with the certificate, so every later renewal reloads nginx:

   ```bash
   D=tickets.example.com
   E=admin@example.com
   sudo mkdir -p /etc/letsencrypt/live/$D
   sudo openssl req -x509 -nodes -newkey rsa:2048 -days 1 -subj /CN=$D -keyout /etc/letsencrypt/live/$D/privkey.pem -out /etc/letsencrypt/live/$D/fullchain.pem
   sudo nginx -t && sudo systemctl reload nginx
   sudo rm -rf /etc/letsencrypt/live/$D
   sudo certbot certonly --webroot -w /var/www/certbot -d $D --email $E --agree-tos --no-eff-email --staging
   sudo certbot certonly --webroot -w /var/www/certbot -d $D --email $E --agree-tos --no-eff-email --force-renewal --deploy-hook "systemctl reload nginx"
   sudo systemctl reload nginx
   ```

4. **Renewal.** The `certbot` package installs a systemd timer that runs `certbot renew` twice a day. Check that it's
   active, and do a dry run:

   ```bash
   systemctl list-timers certbot.timer
   sudo certbot renew --dry-run
   ```

   Without systemd, use a cron job instead, for example `/etc/cron.d/certbot-renew`:
   `0 3,15 * * * root certbot renew --quiet --deploy-hook "systemctl reload nginx"`.

## 4. Settings once HTTPS works

Both options:

| Setting            | Value                         | Why                                                                                                                        |
| ------------------ | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `CLIENT_URL`       | `https://tickets.example.com` | Must be https in production; it's also the one origin CORS allows (the app itself doesn't need CORS: same origin)          |
| `APP_URL`          | `https://tickets.example.com` | The links in emails (set-password and reset links) point here. Required when email is on                                   |
| `TRUST_PROXY_HOPS` | `2`                           | Set by both HTTPS Compose files; set it yourself with the apt variant. The API then sees the visitor's IP, not the proxy's |
| Cookies            | nothing to set                | Already `Secure` (`NODE_ENV=production`)                                                                                   |

After changing `deploy/.env`, run `docker compose up -d` so the API picks the values up.

### HSTS

HSTS (`Strict-Transport-Security`) tells browsers to use only HTTPS for this domain, for `max-age` seconds, even when
someone types `http://`. That protects against downgrade attacks, but a browser that has seen the header refuses plain
HTTP until it expires, even if your certificate breaks.

- **Start with `max-age=300`** (5 minutes): the examples' default. If something goes wrong, browsers forget it quickly.
- **Raise it to `31536000`** (a year) once everything has worked over HTTPS for a few days.
  - Caddy: `HSTS_MAX_AGE=31536000` in `deploy/.env`, then `docker compose up -d`.
  - nginx: edit the `add_header Strict-Transport-Security` line, then `nginx -s reload`.
- **No `includeSubDomains`** unless every subdomain of your domain is on HTTPS.
- **No `preload`** until you're sure. Preloading puts the domain on a list built into browsers. Taking it off takes
  months and a browser release, and in the meantime nothing on the domain can go back to HTTP.
- **The API sends HSTS too:** helmet sends 180 days with `includeSubDomains` in production. Both examples remove it at
  the proxy (`header_down -Strict-Transport-Security` and `proxy_hide_header`), so the proxy's value is the only one
  browsers see. Otherwise one API answer would pin the browser to HTTPS for 180 days, whatever you set here.

## 5. Checks

[`deploy/check-https.sh`](../deploy/check-https.sh) runs these from any machine with `curl` (and `jq` for the login
part):

```bash
deploy/check-https.sh tickets.example.com
LOGIN_EMAIL=admin@example.com LOGIN_PASSWORD='…' deploy/check-https.sh tickets.example.com   # also log in and upload
```

The login run adds a 10 MB text file to the newest ticket, so delete it afterwards. Here's what it checks, and how to
check it by hand:

| Check                     | By hand                                                                                                                                     | Expected                                                                 |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| HTTP is redirected        | `curl -I http://tickets.example.com/`                                                                                                       | `301` (nginx) or `308` (Caddy), `Location: https://tickets.example.com/` |
| HTTPS works, with HSTS    | `curl -I https://tickets.example.com/`                                                                                                      | `200`, `strict-transport-security: max-age=300`                          |
| Only TLS 1.2 and 1.3      | `curl -I --tlsv1.1 --tls-max 1.1 https://tickets.example.com/`                                                                              | fails                                                                    |
| The API through the proxy | `curl https://tickets.example.com/api/health`                                                                                               | `{"status":"ok"}`                                                        |
| Login cookie              | log in, then in the browser's dev tools (Application → Cookies)                                                                             | `tf_session` with Secure and HttpOnly                                    |
| Real client IP            | Audit log page, your login                                                                                                                  | your own address, not 172.x (a container)                                |
| Email links               | with email on, send yourself a password reset                                                                                               | the link starts with `https://tickets.example.com/`                      |
| Attachments               | upload a file of about 10 MB on a ticket                                                                                                    | saved; over 11 MB gets "too large"                                       |
| Grade                     | [SSL Labs](https://www.ssllabs.com/ssltest/), enter the domain                                                                              | **A**. A+ needs the long HSTS                                            |
| Renewal                   | `docker compose run --rm certbot renew --dry-run`, or `sudo certbot renew --dry-run` (Caddy renews on its own: `docker compose logs caddy`) | "Congratulations, all simulated renewals succeeded"                      |

**What CI checks.** CI tests all three setups on every pull request (the "HTTPS example" jobs in
`.github/workflows/ci.yml`), with local certificates in place of Let's Encrypt:

- **Caddy:** `caddy validate` and `caddy fmt`, then the whole stack with `DOMAIN=localhost` (Caddy's local CA).
- **nginx (Docker):** the first-certificate step 1 (the temporary certificate), `nginx -t`, then the whole stack with
  that certificate, and the `certbot-renew` container running.
- **nginx + certbot from apt:** the apt variant's commands as written on the Ubuntu runner:
  - the domain `sed`, the install, the site and its `sed`;
  - the temporary certificate, `nginx -t` and the reload;
  - the certbot timer;
  - `web` published on `127.0.0.1:8080` only.
- **All three:** `check-https.sh` with a login and uploads, with the audit-log IP compared with the containers'
  addresses. With Docker, `web` is no longer reachable on port 8080.

**What needs a real domain and server:** the Let's Encrypt challenge and certificate, renewal against Let's Encrypt,
the SSL Labs grade, and a browser trusting the certificate. Check those on the server with the table above.

## 6. Troubleshooting

| Symptom                                                               | Cause and fix                                                                                                                                                                                                             |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Challenge fails: "DNS problem: NXDOMAIN", or the wrong IP             | DNS doesn't point at the server yet. Check with `dig` (section 1) and wait. Also check the `AAAA` record: Let's Encrypt tries IPv6 first                                                                                  |
| Challenge fails: "Connection refused" / "Timeout during connect"      | Port 80 is closed: the server's firewall, or the cloud provider's. Both must allow 80 (and 443)                                                                                                                           |
| "too many certificates already issued" / rate limited                 | Too many tries. Use the staging CA (`ACME_CA=` staging with Caddy, `--staging` with certbot) until it works. Limits reset within a week                                                                                   |
| Certificates requested again after every restart                      | The certificate volume is missing or was deleted (`caddy-data`, or `letsencrypt` with nginx). Don't use `docker compose down -v`                                                                                          |
| nginx won't start: `cannot load certificate`                          | The files aren't there yet: do "Getting the first certificate" step 1. Or the domain in `https.conf` doesn't match the certificate's folder                                                                               |
| Redirect loop (`ERR_TOO_MANY_REDIRECTS`)                              | Something behind the proxy redirects to HTTPS again. TicketFlow's containers never do, so check for a second proxy or a CDN set to "flexible" SSL. It must connect to the server over HTTPS (Cloudflare: "Full (strict)") |
| Login doesn't stick (logged out at once)                              | The page is on `http://`, so the browser refuses the `Secure` cookie. Open the `https://` address. Also check `CLIENT_URL` is that address                                                                                |
| "Mixed content" warnings                                              | Something loads an `http://` URL on the https page. The app only uses relative `/api` URLs, so look for a frontend built with `VITE_API_URL=http://…` (rebuild with the default `/api`)                                   |
| Everyone shares one login limit / the audit log shows 172.x addresses | `TRUST_PROXY_HOPS` is too low: it must be `2` with an HTTPS proxy in front of `web` (then `docker compose up -d`)                                                                                                         |
| Upload of a few MB fails with 413                                     | The outer proxy's body limit: `client_max_body_size 11m` (nginx) is in the example; a CDN or load balancer in front may have its own                                                                                      |
| The app is still reachable on port 8080                               | The HTTPS Compose file isn't in use (check `COMPOSE_FILE` / `-f`), or the apt variant without `WEB_PORT=127.0.0.1:8080`                                                                                                   |

## 7. Which one to choose

- **Caddy**, for most setups. It's one short file and needs no first-certificate steps. It renews and reloads on its
  own, and supports HTTP/3. There's nothing to forget.
- **nginx + certbot** if the server already runs nginx for other sites (use the apt variant and add TicketFlow as one
  more site), if your team knows nginx, or if you need something nginx does that Caddy doesn't in your setup. It's more
  to set up, and renewal depends on the timer (or the `certbot-renew` container) and a reload.

Both send the same headers to TicketFlow, so the app behaves the same behind either one.
