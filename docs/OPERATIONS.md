# Installing and running TicketFlow

For the IT person who looks after TicketFlow: what it needs, how to install and update it, backups, monitoring,
accounts, security and what to do when something goes wrong. The step-by-step server setup (DNS, firewall, HTTPS) is
[DEPLOY.md](DEPLOY.md); HTTPS in detail is [https.md](https.md).

Every command runs **on the server, in `/srv/ticketflow/Ctrl-HelpBackend/deploy`**, unless it says otherwise.
`helpdesk.example.com` stands for your address.

- [1. Requirements](#1-requirements)
- [2. Install](#2-install)
- [3. Update](#3-update)
- [4. Backup and restore](#4-backup-and-restore)
- [5. Monitoring](#5-monitoring)
- [6. Users](#6-users)
- [7. Security checklist](#7-security-checklist)
- [8. Troubleshooting](#8-troubleshooting)

## 1. Requirements

|      | ~50 users                  | ~500 users         |
| ---- | -------------------------- | ------------------ |
| CPU  | 2 vCPU                     | 4 vCPU             |
| RAM  | 2 GB (4 GB is comfortable) | 8 GB               |
| Disk | 40 GB SSD                  | 100 GB SSD or more |

Disk is mostly attachments (up to 10 MB each) and backups: 14 days of database **and** attachment backups are kept on
the server (section 4). Plan for the attachments' total size × 15, then add room to grow.

- **OS**: Ubuntu 24.04 LTS (other Linux distributions with Docker work too).
- **Docker Engine 27 or newer** and the **Compose plugin 2.24.4 or newer** (the HTTPS files use `!reset`/`!override`):
  `docker version` and `docker compose version`.
- **A domain name** pointing at the server (an `A` record, and `AAAA` for IPv6).
- **Ports 80 and 443** open from the internet (Let's Encrypt and the redirect need 80); nothing else.
- **SMTP** (optional): an SMTP account to send password links and notifications. Without it, admins hand out temporary
  passwords instead.
- **Somewhere else to copy backups to** (another server, a NAS, object storage).

Where the data lives (Docker volumes; `docker volume ls`):

| Volume                    | What                                                                              |
| ------------------------- | --------------------------------------------------------------------------------- |
| `ticketflow_db`           | The database (tickets, users, settings, audit log)                                |
| `ticketflow_uploads`      | Attachment files                                                                  |
| `ticketflow_backups`      | The daily backups and the backups taken before each migration                     |
| `ticketflow_caddy-data`   | Caddy's certificates (keep it: Let's Encrypt limits how often it issues new ones) |
| `ticketflow_caddy-config` | Caddy's last configuration (recreated on start)                                   |

The settings, including every password, are in `deploy/.env` (`chmod 600`, never in git).

## 2. Install

The short path; [DEPLOY.md](DEPLOY.md) has every step in detail (DNS, firewall, Docker, the email settings).

1. Get both repositories, next to each other:

   ```bash
   sudo mkdir -p /srv/ticketflow && sudo chown "$USER" /srv/ticketflow && cd /srv/ticketflow
   git clone https://github.com/enesasejdiu/Ctrl-HelpBackend.git
   git clone https://github.com/enesasejdiu/Ctrl-HelpFrontend.git
   ```

2. Generate the settings file with fresh secrets:

   ```bash
   cd /srv/ticketflow/Ctrl-HelpBackend/deploy
   ./make-env.sh .env --domain helpdesk.example.com --email admin@example.com
   ```

   Expected: `Wrote .env (secrets generated; readable only by you). Site: https://helpdesk.example.com`. Add the SMTP
   settings to `.env` now if you have them (DEPLOY.md step 4).

3. Start everything (the first start builds the images, a few minutes):

   ```bash
   docker compose up -d --build --wait
   docker compose ps
   ```

   Expected: `db`, `api` and `web` show `Up … (healthy)`; `caddy` and `backup` show `Up …`.

4. Create the first admin:

   ```bash
   docker compose run --rm api npm run create-admin -- --name "Ana Admin" --email ana@example.com
   ```

   Expected (email not set up):

   ```text
   Admin account created: Ana Admin <ana@example.com> (id 1)
   Temporary password (shown only now): …
   Log in with it; you will be asked to choose your own password straight away.
   ```

   With email set up it prints a one-time set-password link instead (nothing is emailed). Open
   `https://helpdesk.example.com`, sign in and choose a password. Create everyone else in the app (Users).

**Never run `npm run db:seed` on a real installation**: it deletes every table and fills in demo accounts with a
known password.

## 3. Update

1. Make a backup and note the version you're on:

   ```bash
   docker compose run --rm backup backup-now
   git -C .. rev-parse --short HEAD && git -C ../../Ctrl-HelpFrontend rev-parse --short HEAD
   ```

2. Get the new version and rebuild:

   ```bash
   git -C .. pull && git -C ../../Ctrl-HelpFrontend pull
   docker compose up -d --build --wait
   ```

   New database migrations run by themselves when the API starts, **after the API backs up the database** (into the
   `ticketflow_backups` volume, as `ticketflow-<date>.sql`).

3. Check that it worked:

   ```bash
   docker compose ps                                       # every service "Up", db/api/web "(healthy)"
   docker compose logs api | grep -E 'Applied|up to date'   # "Applied 0xx_….sql" for new migrations, then "up to date"
   curl -s https://helpdesk.example.com/api/health          # {"status":"ok"}
   ```

   The log keeps the lines of earlier starts too: the **last** `up to date (migrations applied: N)` line is this start's.
   Then sign in and open a ticket.

**If an update fails** (the API keeps restarting, or the app misbehaves):

1. Look at why: `docker compose logs --tail 50 api` (a failed migration stops the API and says which one).
2. Go back to the previous code, the commit you noted in step 1 (there are no release tags yet; tag releases from
   now on with `git tag v1.0.0 && git push --tags`, so this can be `git checkout v1.0.0`):

   ```bash
   git -C .. checkout <backend commit> && git -C ../../Ctrl-HelpFrontend checkout <frontend commit>
   ```

3. If a migration had already changed the database, put back the backup from step 1 (section 4, "Restore"), with the
   API stopped. Then `docker compose up -d --build --wait`.
4. Back on the newest version later: `git -C .. checkout main && git -C ../../Ctrl-HelpFrontend checkout main`, then
   step 2.

## 4. Backup and restore

The `backup` service backs up **the database and the attachments** every night at `BACKUP_TIME` (default `02:30`,
time zone `TZ`) into the `ticketflow_backups` volume, and keeps the newest `BACKUP_KEEP` (default **14**) of each.
Change them in `.env`, then `docker compose up -d`.

```bash
docker compose run --rm backup backup-now            # a backup now: "[backup] ok ticketflow-….sql.gz (…) ticketflow-uploads-….tar.gz (…)"
docker compose run --rm backup list                  # every backup, newest first, with sizes
docker compose logs backup | grep -E 'ok|FAILED'     # the nightly runs (backup-now prints in your terminal instead)
```

### Copy backups off the server

A backup on the same disk is lost with the disk. Copy the folder every day to another machine, e.g. with rsync over
SSH, from the server's root crontab (`sudo crontab -e`), after `BACKUP_TIME`:

```bash
0 4 * * * rsync -a /var/lib/docker/volumes/ticketflow_backups/_data/ backup@backup.example.com:/srv/ticketflow-backups/ 2>&1 | logger -t ticketflow-offsite
```

Use an SSH key without a passphrase that may only write to that folder on `backup.example.com`, run the command once
by hand to accept the host key, and check `journalctl -t ticketflow-offsite` the next day. (rsync comes with Ubuntu;
`sudo apt install rsync` on the other machine if it's missing there.) Keep the copies private:
they contain emails and password hashes.

### Restore

1. Pick the files: `docker compose run --rm backup list` (a database file, and the uploads file of the same time).
2. Stop the API: `docker compose stop api`.
3. Restore (it asks you to type `RESTORE`):

   ```bash
   docker compose run --rm backup restore ticketflow-2026-11-17-0230.sql.gz --uploads ticketflow-uploads-2026-11-17-0230.tar.gz
   ```

4. Start the API: `docker compose start api`.

A backup from elsewhere: copy it into the volume first,
`docker run --rm -v ticketflow_backups:/backups -v "$PWD":/in alpine:3.24 cp /in/<file> /backups/`.

### Test a restore once a month

Restore the newest backup into a throwaway copy, never the real one: README "Backups" → "Test a restore once a month".
Put it in your calendar; a backup that has never been restored is a guess.

## 5. Monitoring

- **Health**: `https://helpdesk.example.com/api/health` answers `{"status":"ok"}`. Point an uptime checker at it.
- **Containers**: `docker compose ps`: everything `running`, db/api/web `healthy`. Containers restart by themselves
  (`restart: unless-stopped`), also after a reboot.
- **Logs**: `docker compose logs -f api` (one JSON line per entry, README "Logs"). One request's lines, by the reference
  a user quotes from "Something went wrong (reference: …)":

  ```bash
  docker compose logs api | grep 3f0c9d2e-1a2b-4c3d-9e8f-0a1b2c3d4e5f
  ```

  The `error` line has the message and the stack. Also: `docker compose logs caddy` (HTTPS, certificates),
  `docker compose logs backup` (backups).

- **Sentry** (optional): set `SENTRY_DSN` / `WEB_SENTRY_DSN` in `.env` to get server errors and crashes reported, without
  personal data (README "Error tracking").
- **Disk space**: `df -h /` and `docker system df`. Keep at least 20% free; a full disk stops the database. The backups'
  size: `sudo du -sh /var/lib/docker/volumes/ticketflow_backups/_data`.

## 6. Users

- **The first admin**: `docker compose run --rm api npm run create-admin -- --name "…" --email …` (section 2). It
  refuses an email that already exists.
- **An admin who is locked out or forgot the password**:
  - 5 wrong passwords lock the account for **15 minutes**: wait, then sign in.
  - Another admin can reset the password (Users → the person → **Reset password**): that also unlocks the account at
    once and hands out a new temporary password (or an emailed link, with email set up).
  - With email set up, "Forgot password" on the sign-in page sends a reset link.
  - The only admin, and no email: create a second admin with `create-admin`, sign in with it, and reset the first one.
- **Someone leaves**: Users → the person → **Deactivate** (it asks first). They can't sign in any more, and their
  sessions end at once. Their tickets and the history stay; an agent's or admin's unfinished tickets are unassigned, so
  someone else picks them up. Accounts are deactivated, never deleted; **Activate** brings one back.
- **Exporting or anonymising someone's personal data**: there is no function for that yet. Note any such request and
  ask the developers.

## 7. Security checklist

- [ ] `JWT_SECRET` is long and random (`make-env.sh` makes 96 characters); the API refuses a weak one in production.
- [ ] HTTPS only: `http://` redirects to `https://`, the certificate is valid (Caddy renews it by itself; port 80 must
      stay open for that).
- [ ] Firewall: only 22, 80 and 443 open (DEPLOY.md step 2). Nothing else publishes a port.
- [ ] `TRUST_PROXY_HOPS` matches the proxies in front of the API: **Caddy + the web container = 2** (set by
      `docker-compose.https.caddy.yml`), **only the web container = 1**. Wrong, and everyone shares one login limit or
      a client can fake its address.
- [ ] `npm run db:seed` is never run here.
- [ ] `deploy/.env` is `chmod 600` and kept in a password manager; nobody else on the server can read it.
- [ ] Who can read backups: only root on the server (Docker volumes) and the off-server copy's owner. They contain
      emails and password hashes; keep the copy private.
- [ ] Updates: the app (section 3), Ubuntu (`unattended-upgrades`), and the base images: rebuild with
      `docker compose build --pull && docker compose up -d --wait` once a month.
- [ ] Admins are few, and leavers are deactivated the day they go.

## 8. Troubleshooting

| Problem                                                                         | Cause                                                                                                                                                                                       | Fix                                                                                                                                             |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| The `api` container keeps restarting                                            | The config check refused a setting: `docker compose logs api` shows `Invalid configuration:` and a list, e.g. `JWT_SECRET is only 12 characters`, `CLIENT_URL must use https in production` | Fix the setting in `.env`, then `docker compose up -d`                                                                                          |
| `… is new but numbered below …, which is already applied. Renumber it`          | A migration file was added with a number lower than one already applied (two branches took the same number)                                                                                 | Developers renumber the new file; then update again. Nothing was changed                                                                        |
| `Migration failed: Access denied for user …` / `[entrypoint] Migrations failed` | The database password in `.env` differs from the one inside the database (passwords are set only when the volume is created)                                                                | Put the old password back in `.env`, or change it inside MySQL first (`ALTER USER`)                                                             |
| The API waits for the database / `db` not healthy                               | MySQL is still starting (the first start can take a minute) or out of disk                                                                                                                  | `docker compose logs db`; `df -h /`                                                                                                             |
| Uploads fail with 413                                                           | A file over 10 MB (`Each file can be at most 10 MB`, `FILE_TOO_LARGE`); over 11 MB nginx and Caddy refuse it first                                                                          | The limit is fixed at 10 MB per file; compress or split the file                                                                                |
| Emails don't arrive                                                             | Email is off or SMTP fails: `docker compose logs api \| grep '\[mail\]'` shows `Email is off` or `Could not send … `                                                                        | Set `MAIL_ENABLED=true`, `SMTP_HOST`, `MAIL_FROM` (and `SMTP_USER`/`SMTP_PASS`), then `docker compose up -d`; the log line says why SMTP failed |
| `403 CSRF_INVALID` ("Missing or invalid CSRF token") after changing the domain  | Old cookies from the old address, or `CLIENT_URL`/`APP_URL`/`DOMAIN` still the old one                                                                                                      | Set all three to the new address, `docker compose up -d`; users sign in again (reload the page)                                                 |
| `423 ACCOUNT_LOCKED`                                                            | 5 wrong passwords: the account is locked for 15 minutes                                                                                                                                     | Wait, or an admin resets the password (section 6)                                                                                               |
| `429 RATE_LIMITED` "Too many login attempts"                                    | 20 failed logins from one address in 15 minutes (successful ones don't count)                                                                                                               | Wait 15 minutes. Everyone gets it at once? `TRUST_PROXY_HOPS` is too low (section 7)                                                            |
| `Bind for 0.0.0.0:443 failed: port is already allocated`                        | Another web server (Apache, nginx) holds 80/443                                                                                                                                             | `sudo ss -ltnp 'sport = :443'`; stop or remove that server                                                                                      |
| Disk full: the database stops, errors everywhere                                | Attachments, backups or old Docker images filled the disk                                                                                                                                   | `df -h /`, `docker system df`; `docker image prune` (old images only); lower `BACKUP_KEEP` after copying backups off; grow the disk             |
| A user reports "Something went wrong (reference: …)"                            | A server error                                                                                                                                                                              | `docker compose logs api \| grep <reference>`: the error line with its stack. Tell the developers                                               |
