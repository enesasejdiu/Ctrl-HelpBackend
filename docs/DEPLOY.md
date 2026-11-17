# Deploying TicketFlow on a server

How to run TicketFlow for real on one server: a VPS with **Ubuntu 24.04**, Docker Compose, and **Caddy** in front with a
free **Let's Encrypt** certificate. HTTPS itself is described in [docs/https.md](https.md) (Option A: Caddy, or Option
B: nginx + certbot); this guide is the whole server around it and links there instead of repeating it. The same setup
runs locally as the staging stack ([docs/staging-check.md](staging-check.md)).

```text
browser ──https──▶ caddy (:443, Let's Encrypt; :80 only redirects) ──▶ web (nginx: the page, /api) ──▶ api ──▶ db
                                                                                               backup ─┘ (daily)
```

Only Caddy is reachable from the internet: the database, the API and the web service are on Compose's internal network
and publish no ports (`docker-compose.https.caddy.yml` removes web's).

## What you need

- A VPS with Ubuntu 24.04, 2 GB RAM or more, 20 GB disk or more (attachments and backups grow), and SSH access as a
  user with `sudo`.
- A domain or subdomain you control, e.g. `helpdesk.example.com`.
- An SMTP account for email (your mail provider, or a service such as Postmark, Mailgun or Amazon SES). It is optional:
  without it, new and reset passwords are shown to the admin as temporary passwords instead of being emailed.
- Somewhere to copy backups to that is **not** this server (another server, a NAS, object storage).

## 1. Point the domain at the server

At your DNS provider, add an `A` record (and `AAAA` for IPv6, if the server has one) for `helpdesk.example.com` to the
server's public IP address. Check it before going on; Caddy can only get a certificate once the name resolves:

```bash
dig +short helpdesk.example.com      # must print the server's IP
```

## 2. Prepare the server

```bash
sudo apt update && sudo apt -y upgrade
sudo apt -y install ca-certificates curl git ufw unattended-upgrades
sudo dpkg-reconfigure -plow unattended-upgrades   # security updates install themselves

# Docker Engine and the Compose plugin, from Docker's own repository (docs.docker.com/engine/install/ubuntu)
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" |
  sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
sudo apt update && sudo apt -y install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker "$USER"   # then log out and in again
docker compose version
```

### Firewall: only SSH, 80 and 443

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp     # Let's Encrypt's check and the redirect to https
sudo ufw allow 443/tcp
sudo ufw allow 443/udp    # HTTP/3
sudo ufw enable
sudo ufw status
```

> **Docker and ufw:** Docker writes its own firewall rules, and a port a container publishes is reachable from outside
> **even if ufw blocks it**. That is why only Caddy publishes ports (80 and 443): with `docker-compose.https.caddy.yml`
> the web service publishes none, and the database and API never do. Don't add `ports:` to them. Check from another
> machine afterwards: `nc -zv helpdesk.example.com 8080` and `3306` must fail.

If your provider has its own firewall (Hetzner, AWS security groups, ...), open the same three ports there.

## 3. Get the code

Both repositories, next to each other (the compose file builds the web app from `../../Ctrl-HelpFrontend`):

```bash
sudo mkdir -p /srv/ticketflow && sudo chown "$USER" /srv/ticketflow && cd /srv/ticketflow
git clone https://github.com/enesasejdiu/Ctrl-HelpBackend.git
git clone https://github.com/enesasejdiu/Ctrl-HelpFrontend.git
```

## 4. Settings: generate deploy/.env

```bash
cd /srv/ticketflow/Ctrl-HelpBackend/deploy
./make-env.sh .env --domain helpdesk.example.com --email admin@example.com
```

It copies `.env.example` and fills in fresh secrets (database passwords, a 48-byte `JWT_SECRET`), `CLIENT_URL` /
`APP_URL` `https://helpdesk.example.com`, `DOMAIN` and `ACME_EMAIL` for Caddy (Let's Encrypt sends certificate notices
to that address), `COMPOSE_FILE=docker-compose.yml:docker-compose.https.caddy.yml` (so a plain `docker compose` uses
the HTTPS setup) and `LOG_LEVEL=info`. The file is `chmod 600` and git-ignored; it never overwrites an existing one.

Then open `.env` and set what only you know:

- **Email** (optional): `MAIL_ENABLED=true`, `SMTP_HOST`, `SMTP_PORT` (587, or 465 with `SMTP_SECURE=true`),
  `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM="Helpdesk <helpdesk@example.com>"`, and `IT_NOTIFY_EMAIL` for new-ticket
  notices.
- `TZ` (default `Europe/Budapest`) and `BACKUP_TIME` (default `02:30`).
- For the very first start, Let's Encrypt's staging CA and a short HSTS, as [docs/https.md](https.md) explains
  (`ACME_CA=…acme-staging…`, `HSTS_MAX_AGE=300`); switch to the real CA once it works.
- Error tracking (optional): `SENTRY_DSN` / `WEB_SENTRY_DSN` (README "Error tracking").

> **`TRUST_PROXY_HOPS` is the number of proxies in front of the API.** Caddy + the web container (nginx) = **2**: that
> is this setup, and `docker-compose.https.caddy.yml` sets it for you. Only the web container (no HTTPS proxy in front)
> = **1**, the default. Too low and every user looks like the proxy: they all share one login limit and the audit log
> shows the proxy's address. Too high and a client could pick its own address with a fake `X-Forwarded-For`. The
> staging check proves the value: the audit log shows the client's address, and a faked `X-Forwarded-For` changes
> nothing ([docs/staging-check.md](staging-check.md)).
>
> The **login rate limit** is per address and counts **failed** attempts only (20 per 15 minutes; then 429).
> Successful sign-ins don't count, so an office where everyone comes from one address is never blocked by its own
> logins. Each account is also locked for 15 minutes after 5 wrong passwords.

Keep a copy of `.env` in your password manager: without it the backups' database can still be restored, but you would
have to reset every session secret and password by hand.

## 5. Start

```bash
cd /srv/ticketflow/Ctrl-HelpBackend/deploy
docker compose up -d --build --wait      # COMPOSE_FILE in .env adds docker-compose.https.caddy.yml
docker compose ps
docker compose logs caddy | grep -i -E 'certificate obtained|error'
```

All services should be `running` (db, api and web also `healthy`). The API's log shows the migrations, then
`TicketFlow API running`. Caddy asks Let's Encrypt for a certificate on the first start; that needs the DNS record from
step 1 and ports 80/443 open. Open **https://helpdesk.example.com**: the login page, with a valid padlock. The checks
and the troubleshooting for the certificate are in [docs/https.md](https.md) ("Checks", "Troubleshooting").

## 6. The first admin

```bash
docker compose run --rm api npm run create-admin -- --name "Your Name" --email you@example.com
```

With email set up it prints a one-time set-password link (nothing is emailed); without email, a temporary password that
must be changed at the first login. Sign in, then create the other accounts in the app (Users).

**Never run `npm run db:seed` here**: it wipes every table and fills in demo accounts with a known password.

## 7. Backups, and copies off the server

The `backup` service backs up the database and the attachments every night at `BACKUP_TIME`, keeping the last 14
(README "Backups"). They are on this server's disk, so **copy them elsewhere every day**. A disk failure, a deleted
VPS or ransomware takes the server and its backups together.

Example: a daily cron job on the server that pushes the volume's files to another machine with rsync over SSH (use an
SSH key that may only write to that one folder):

```bash
sudo crontab -e
# 04:00, after BACKUP_TIME; the volume's folder is /var/lib/docker/volumes/ticketflow_backups/_data
0 4 * * * rsync -a --delete-after /var/lib/docker/volumes/ticketflow_backups/_data/ backup@backup-host:/srv/ticketflow-backups/ 2>&1 | logger -t ticketflow-offsite
```

Or to object storage with [rclone](https://rclone.org) (`rclone copy … remote:bucket/ticketflow`). Keep more than
14 days there if you can, and keep it private: backups contain emails and password hashes.

Check that it works:

```bash
docker compose run --rm backup backup-now     # a backup now
docker compose run --rm backup list           # the backups, newest first
docker compose logs backup | grep -E 'ok|FAILED'
```

**Once a month, test a restore** into a throwaway copy (README "Backups" → "Test a restore once a month"). A backup that
has never been restored is a guess.

## 8. Updating

```bash
cd /srv/ticketflow/Ctrl-HelpBackend && git pull
cd ../Ctrl-HelpFrontend && git pull
cd ../Ctrl-HelpBackend/deploy
docker compose run --rm backup backup-now     # a fresh backup first
docker compose up -d --build --wait
```

New migrations run by themselves when the API starts (after the API's own backup of the database). If a migration
fails, the API stops with the error in `docker compose logs api`; nothing else changes. Read the release notes before
updating, and update during a quiet hour: the API is down for a few seconds while its container is replaced.

Ubuntu itself: `unattended-upgrades` installs security updates; reboot when `/var/run/reboot-required` exists (the
containers start again by themselves, `restart: unless-stopped`).

## 9. When something goes wrong

| Symptom                                                 | Look at                                                                                            |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| The page doesn't load                                   | `docker compose ps`; `docker compose logs caddy web`; [docs/https.md](https.md) "Troubleshooting"  |
| "Something went wrong (reference: …)"                   | `docker compose logs api \| grep <reference>`: the error with its stack (README "Logs")            |
| Everyone gets 429 / the audit log shows 172.x addresses | `TRUST_PROXY_HOPS` must be 2 behind Caddy + web (`docker compose config \| grep TRUST_PROXY_HOPS`) |
| No emails arrive                                        | `docker compose logs api \| grep '\[mail\]'`; the SMTP settings in `.env`                          |
| The certificate expired                                 | `docker compose logs caddy`; port 80 must stay open for renewals ([docs/https.md](https.md))       |
| A backup `FAILED`                                       | `docker compose logs backup`; the line says why                                                    |

## Checklist

Before you hand it over:

- [ ] DNS `A`/`AAAA` record points at the server; `https://<domain>` has a valid certificate
- [ ] `http://<domain>` redirects to `https://<domain>`
- [ ] ufw (and the provider's firewall) allow only 22, 80, 443; `nc -zv <domain> 8080` and `3306` fail from outside
- [ ] `deploy/.env` made with `make-env.sh`, `chmod 600`, a copy in the password manager; `docker compose config` shows `TRUST_PROXY_HOPS: "2"` for the api
- [ ] `docker compose ps`: everything running, db/api/web healthy
- [ ] The first admin made with `create-admin`; signed in; the temporary password changed
- [ ] Email: a new user gets the set-password email (or email is consciously left off)
- [ ] `backup-now` works; the off-server copy runs daily and you have checked it arrived
- [ ] A restore tested once (and a monthly reminder for the next one)
- [ ] `db:seed` has never been run on this server
- [ ] Someone knows where the logs are and what a "reference" is
