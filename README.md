# TicketFlow Backend

![Backend CI](https://github.com/enesasejdiu/Ctrl-HelpBackend/actions/workflows/ci.yml/badge.svg)

TicketFlow is an IT helpdesk / ticketing system. Employees report IT problems as tickets, agents pick them up,
work on them and resolve them, and admins manage users and follow the team's performance on a statistics dashboard.

This repository is the REST API. The frontend lives in a separate repository: **ticketflow-frontend**.

## Tech stack

- **Node.js** + **Express 5**: REST API
- **MySQL 8** with **mysql2**: database (connection pool, `?` placeholders for every query)
- **jsonwebtoken**: login tokens (JWT, carried in an httpOnly cookie; see [Sessions](#sessions-cookies-and-csrf))
- **cookie-parser**: reads the session and CSRF cookies
- **bcryptjs**: password hashing
- **helmet**, **cors**: security headers and allowing the frontend origin
- **dotenv**: configuration from `.env`
- **nodemon**: auto-restart during development

## Requirements

- Node.js 22 or newer (`engines` in package.json; CI tests Node 22 and 24)
- MySQL 8 running locally, **or** XAMPP (MariaDB 10.4 or newer). Both work with the same code and scripts.

## Setup

```bash
npm install
cp .env.example .env
```

Edit `.env`: set `DB_PASSWORD` to your MySQL root password (leave it empty if root has none) and set `JWT_SECRET`
to a long random string. Generate one with:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

`src/config.js` checks the settings whenever the server or a database script starts. A missing or malformed setting
stops it with a list of what to fix. With `NODE_ENV=production` it also refuses to start when `JWT_SECRET` is
shorter than 32 characters or a known placeholder (such as the one in `.env.example`), or when `CLIENT_URL` isn't
`https`. In development these are only warnings.

> **Using XAMPP?** Start MySQL from the XAMPP Control Panel. XAMPP's root user has no password by default, so
> leave it empty: `DB_PASSWORD=` (nothing after the `=`). If you put any value there, `npm run db:migrate` cannot connect.

```bash
npm run db:migrate   # creates the "ticketflow" database and all tables
npm run db:seed      # fills the empty database with demo data
npm run dev          # starts the API with auto-reload
```

The API runs on **http://localhost:5050**. Check it with http://localhost:5050/api/health → `{ "status": "ok" }`.
(Port 5000 is not used because macOS AirPlay occupies it.)

| Script                          | Description                                                                         |
| ------------------------------- | ----------------------------------------------------------------------------------- |
| `npm start`                     | Start the server                                                                    |
| `npm run dev`                   | Start with nodemon (auto-reload)                                                    |
| `npm run db:migrate`            | Create the database or apply new migrations                                         |
| `npm run db:seed`               | Insert the demo data (empty database only)                                          |
| `npm run db:rollback`           | Undo the most recent migration (backs up first)                                     |
| `npm run db:department-report`  | Read-only: the free-text department values migration 005 will turn into departments |
| `npm run db:verify-departments` | Read-only: checks that migration 005 linked every user correctly                    |
| `npm run db:backup`             | Back up the database to `backups/`                                                  |
| `npm run db:sessions:cleanup`   | Delete sessions that ended more than 7 days ago (also runs daily in the server)     |
| `npm test`                      | Run all tests once (see [Running tests](#running-tests))                            |
| `npm run test:coverage`         | Run the tests with a coverage report                                                |
| `npm run lint`                  | Check the code with ESLint (fails on any error or warning)                          |
| `npm run format`                | Format every file with Prettier                                                     |
| `npm run format:check`          | Check that every file is formatted (what CI runs)                                   |

## Updating and migrations

The database structure lives in numbered files in `migrations/`. To update an installation without losing its data:

```bash
git pull
npm install
npm run db:migrate
```

Then restart the server. `db:migrate` runs only the files this database hasn't run yet, in number order, and records
each one in the `schema_migrations` table. If there is something to apply and the database already has tables, it
makes a backup first, and stops if the backup fails.

To change the database, add a new file with the next number, such as `migrations/002_add_ticket_tags.sql`:

- **Never edit a migration that has been applied or pushed.** `db:migrate` refuses to run if an applied file changed.
  Put the change in a new file instead.
- **Keep the data.** Change tables with `ALTER TABLE`, and when you rename or reshape a column, move its data in the
  same migration.
- **Pull before picking a number.** Two files with the same number stop `db:migrate` until one is renumbered.
- Each statement ends with `;`. `DELIMITER` doesn't work, because it's a feature of the `mysql` command line.

To undo the most recent migration, run `npm run db:rollback`. It backs up first, runs the file with the same name in
`migrations/down/`, and removes the migration from `schema_migrations` so the next `db:migrate` applies it again. It
undoes one migration per run, and refuses if that migration has no file in `migrations/down/` (001 and 002 have none).
A rollback usually deletes data (the columns and tables the migration added), so read the down file first. When you
add a migration that can be undone, add its down file in the same commit.

MySQL can't roll back schema changes, so a migration that fails partway can leave some of its changes in place. Restore
the backup named in the error, fix the file, and run `db:migrate` again. A restore doesn't remove tables that aren't in
the backup, so drop any table the failed migration created.

## Backups and reseeding

`npm run db:backup` writes the whole database to `backups/ticketflow-<YYYY-MM-DD-HHmm>.sql`. It uses `mysqldump`, or
falls back to `mysql2` if `mysqldump` isn't installed. The `backups/` folder is ignored by git and must never be
committed, because backups contain emails and password hashes.

To restore a backup (this replaces the current tables):

```bash
mysql -u root ticketflow < backups/ticketflow-<YYYY-MM-DD-HHmm>.sql
```

`npm run db:seed` **wipes every table**, so it refuses to run if the `users` table already has rows. To really wipe
and reseed a non-empty database, back it up first and pass `--force`:

```bash
npm run db:backup
npm run db:seed -- --force
```

## Running tests

```bash
npm test               # run all tests once
npm run test:watch     # re-run on every file change
npm run test:coverage  # also prints a coverage table (HTML report in coverage/)
```

MySQL must be running (the same server and login as in `.env`).

The tests **never touch the real `ticketflow` database**. Each run creates its own throwaway database named
`ticketflow_test_<timestamp>`, applies all migrations to it (the same code as `npm run db:migrate`) and adds the
categories and priorities. When the run ends it is dropped automatically, also when tests fail. The tests refuse to
start if the database name doesn't begin with `ticketflow_test_`.

Tests live in `tests/**/*.test.js`. `tests/helpers.js` has `api` (a supertest client for the app), `resetData()`,
`createUser()` and `loginAs()`.

## Code style and continuous integration

**Style.** Prettier formats the code with the same settings as the frontend (`.prettierrc.json`: no semicolons,
single quotes, 120 characters per line). ESLint (`eslint.config.js`) checks the code with its recommended rules, and
leaves the layout to Prettier. Before pushing, run `npm run format` and `npm run lint`.

**CI.** [GitHub Actions](.github/workflows/ci.yml) ("Backend CI") runs on every push to `main` and every pull request.
It runs 4 jobs, one for each of **MySQL 8.4** and **MariaDB 11** on **Node 22** and **24**. Each job starts that
database in a container and runs `npm ci`, `npm audit --omit=dev --audit-level=high` (fails on high or critical
known issues in the packages the app runs with), `npm run format:check`, `npm run lint` and `npm run test:coverage`.
MySQL 8.4 keeps its default `ONLY_FULL_GROUP_BY` mode, so queries that MariaDB would allow but MySQL refuses are
caught. The coverage report is kept as a download on the run for 7 days. A newer push to the same branch cancels
the older run.

**Merge a pull request only when all 4 jobs are green.**

**Dependabot** ([`.github/dependabot.yml`](.github/dependabot.yml)) opens update pull requests every Monday: one for
all minor and patch npm updates together, one per major npm update (those can break things), and one for the GitHub
Actions used by the workflow. They run CI like any other pull request.

## Demo accounts

All demo accounts use the password **`password123`**. The demo departments are IT (both agents), Finance, Sales,
Human Resources (the HR account) and Operations, which has nobody in it. The admin has no department.

| Name           | Email                        | Role     |
| -------------- | ---------------------------- | -------- |
| Admin User     | `admin@ticketflow.local`     | admin    |
| Arben Krasniqi | `agent1@ticketflow.local`    | agent    |
| Drita Berisha  | `agent2@ticketflow.local`    | agent    |
| Liridon Gashi  | `employee1@ticketflow.local` | employee |
| Vjosa Hoxha    | `employee2@ticketflow.local` | employee |
| Teuta Morina   | `hr@ticketflow.local`        | hr       |

## Roles

- **Employee**: creates tickets and sees only their own. Can comment on them (never internal notes), close a
  resolved ticket, or reopen a resolved/closed one.
- **Agent**: sees all tickets, takes tickets (assigns them to themselves), changes status and priority, and writes
  public comments and internal notes. Cannot assign tickets to other people.
- **HR**: creates employee accounts, edits their name, email, department and job title, resets their passwords, and
  activates/deactivates them. Cannot change roles or touch staff, HR or admin accounts. For tickets, HR is an employee: own tickets only, no internal notes, no statistics.
- **Admin**: everything an agent can do, plus assign tickets to any active agent/admin, create accounts with any
  role, manage users (change roles, activate/deactivate), and view the statistics.

There is no self-registration. An admin or HR creates each account with `POST /api/users`; the response contains a
**temporary password**, shown only that once (only its hash is stored). Pass it on to the new user, who logs in with
it. `POST /api/users/:id/reset-password` gives an existing account a new temporary password the same way (for a
forgotten password); the old one stops working at once. Their `must_change_password` is `true` until they set their own password with `POST /api/auth/change-password`.
Until then **every other endpoint answers 403** (only `GET /api/auth/me` and the change-password request work):

```json
{ "message": "You must change your password before continuing", "code": "PASSWORD_CHANGE_REQUIRED" }
```

How it works:

- **Login still works** for a flagged user. The response is `{ user }`, and `user.must_change_password` tells the
  client to show its change-password screen right away. A
  successful login also sets `last_login_at`; failed attempts don't (they count towards a lockout, see
  [Login limits](#login-limits-lockout-and-rate-limit)).
- **One check, on every authenticated route.** `requireAuth` (in `src/middleware/auth.js`) runs on every route
  except `POST /api/auth/login`, `POST /api/auth/logout` and `GET /api/health`. It loads the user from the database on each request, so the
  flag is always current. A missing or invalid session is still a 401, checked first. Choosing the new password
  gives the session fresh cookies that are no longer blocked.
- **The allowlist** is `ALLOWED_BEFORE_PASSWORD_CHANGE` in the same file: exactly `GET /api/auth/me` and
  `POST /api/auth/change-password`. Matching is exact method and path; a trailing slash counts as the same path. There
  is no token refresh endpoint.
- **Routers** are mounted from the one list in `src/routes/index.js`. `tests/routes.test.js` walks every route in that
  list and fails if one doesn't need a login or doesn't block a flagged user.

The frontend uses `code` to send the user to its "Set your password" page. A new password needs 10–72 characters with
at least one letter and one number, and must differ from the current one.

### Sessions: cookies and CSRF

A successful `POST /api/auth/login` sets two cookies:

| Cookie       | Holds                   | httpOnly | SameSite | Secure        | Path | Lifetime |
| ------------ | ----------------------- | -------- | -------- | ------------- | ---- | -------- |
| `tf_session` | the JWT                 | yes      | Lax      | in production | `/`  | 8 hours  |
| `tf_csrf`    | a random value (64 hex) | **no**   | Lax      | in production | `/`  | 8 hours  |

The JWT itself is also valid for 8 hours. The browser sends the cookies by itself, so a client sends requests with
credentials (`fetch(..., { credentials: 'include' })`, axios `withCredentials: true`) and never touches the token.
Page scripts can't read `tf_session`, so a script injected into the page can't steal the session.

**CSRF (double-submit cookie).** A POST, PATCH, PUT or DELETE that is authenticated by the cookie must also send the
header `X-CSRF-Token` with the value of the `tf_csrf` cookie. Otherwise it gets:

```json
{ "message": "Missing or invalid CSRF token. Reload the page and try again.", "code": "CSRF_INVALID" }
```

(403). Another site can make the browser send the cookies, but it can't read `tf_csrf` to copy it into the header.
GET requests don't need the header, and neither do login and logout.

**Logout.** `POST /api/auth/logout` ends this browser's session **on the server** (its row in `sessions` gets
`revoked_at`), then clears both cookies and answers 204. So even a copy of the token taken before logging out stops
working. It needs no valid session: with an expired or already ended one it only clears the cookies, and still
answers 204. The user's other sessions keep working. `POST /api/auth/logout-all` (logged in, with the CSRF header)
is "log out everywhere": it ends every session of the user, in every browser and device, this one included.

**When sessions end.** Sessions are stored on the server, in the `sessions` table (migration 008): one row per
login, with `created_at`, `expires_at` (8 hours after login), `revoked_at`, `last_seen_at` (written at most once a
minute), `ip` and `user_agent`. The token carries the row's id as `sid`. Every request checks that the row exists,
belongs to the user and is neither revoked nor expired; otherwise it gets 401 `Session expired, please log in
again`. As a second, independent check, the token also carries the user's `session_version` (migration 007), which
must still match `users.session_version`.

| Event                                                                       | What happens                                                                                                                      |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Logout (`POST /api/auth/logout`)                                            | This session ends (its row is revoked). The user's other sessions keep working.                                                   |
| Log out everywhere (`POST /api/auth/logout-all`)                            | All of the user's sessions end, this one included.                                                                                |
| The user changes their password (`POST /api/auth/change-password`)          | Every **other** session ends (rows revoked). The session that made the change continues as it is, so that person stays logged in. |
| An admin or HR resets the password (`POST /api/users/:id/reset-password`)   | All the user's sessions end (rows revoked, `session_version` raised); they log in with the temporary password.                    |
| The account is deactivated (`PATCH /api/users/:id` with `is_active: false`) | All sessions end. Reactivating doesn't bring them back; the user logs in again.                                                   |
| The role changes (`PATCH /api/users/:id` with a different `role`)           | All sessions end. The new login carries the new role.                                                                             |
| 8 hours after login                                                         | The session expires (the row and the token both end then).                                                                        |

Nothing else ends sessions: edits to name, email, department or job title, saving the role the user already has, a
wrong current password and refused requests all leave them alone. The admin or HR person making a change keeps their
own session. A password change doesn't raise `session_version`, because that would end the current session too; the
revoked rows already end the others.

Tokens from before migration 008 have no `sid`, so they are refused: everyone who was logged in when 008 was applied
logs in once more.

**Cleanup.** Sessions that expired or were revoked more than 7 days ago are deleted when the server starts and then
once a day. Run it by hand with `npm run db:sessions:cleanup`; it only removes ended sessions, so nobody is logged
out.

**CORS.** Only `CLIENT_URL` is allowed (compared exactly), with credentials, the methods `GET, POST, PATCH, PUT,
DELETE` and the headers `Content-Type, X-CSRF-Token`. Any other origin gets no CORS headers at all, so the browser
won't let other sites read the responses. It's never `*`; without `CLIENT_URL`, no origin is allowed.

**Request limits and security headers** (`src/app.js`):

- JSON bodies over **100 KB** get 413 `{ "message": "Request body is too large (at most 100 KB)", "code": "PAYLOAD_TOO_LARGE" }`.
- [helmet](https://helmetjs.github.io/), set up for an API: `Content-Security-Policy: default-src 'none';
frame-ancestors 'none'` (nothing to load, no framing), `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: no-referrer`, same-origin resource and opener policies, and no `X-Powered-By`.
- **Production only** (`NODE_ENV=production`): HSTS (`max-age=15552000; includeSubDomains`, 180 days), and
  `trust proxy` set to 1, so behind nginx `req.ip` (and with it the login rate limit) is the client's real address
  from `X-Forwarded-For`. In development neither is set: HSTS would lock `http://localhost` out of the browser, and
  trusting the header without a proxy would let any client pick its own IP.

**Cookie only, no Bearer.** The session is only ever read from the `tf_session` cookie. No response body contains
the token: login returns `{ user }`, change-password `{ message, user }`. An `Authorization` header is ignored, so
`Authorization: Bearer <token>` on its own is a 401 `Not logged in`, and next to a cookie it changes nothing. Every
client works like a browser: keep the cookies from login, and copy `tf_csrf` into `X-CSRF-Token` on changes. The
frontend does this with axios `withCredentials`, Postman with its cookie jar and the collection's pre-request script
(see [API endpoints](#api-endpoints)), and the tests with a `Cookie` header or a supertest agent.

### Login limits: lockout and rate limit

Two limits protect `POST /api/auth/login` against password guessing:

- **Lockout, per account.** Every wrong password adds 1 to `users.failed_login_count`. The **5th wrong password in a
  row** locks the account for **15 minutes** (`users.locked_until`, migration 006). While it's locked, every login gets
  **423**, even with the right password, and the attempts don't change the count or the lock:

  ```json
  { "message": "Too many wrong passwords. Try again in 15 minutes.", "code": "ACCOUNT_LOCKED", "retryAfterMinutes": 15 }
  ```

  The minutes left are rounded up (at least 1, "1 minute" in the message), and the `Retry-After` header has the
  seconds. The 5th wrong password itself already gets this 423 instead of another 401.

- **How a lock ends.** It runs out by itself after 15 minutes. The next attempt then works normally; a wrong password
  starts the count again at 1. A **successful login** sets the count back to 0 (so wrong passwords only add up between
  successful logins). An **admin or HR password reset** (`POST /api/users/:id/reset-password`) also unlocks the
  account, so the temporary password works at once.
- **Unknown emails** get the same 401 `Wrong email or password` as a wrong password, every time, and are never
  locked. (Note: a known email can still be told apart after 5 wrong passwords, by the 423.)
- **Rate limit, per IP address.** At most **20 login requests per 15 minutes** from one address, right or wrong; then
  **429** until the window has passed, with `Retry-After` and `RateLimit` headers:

  ```json
  { "message": "Too many login attempts. Wait a few minutes and try again.", "code": "RATE_LIMITED" }
  ```

  It's set in `src/middleware/rateLimit.js` (express-rate-limit). The counts are kept in memory, so restarting the
  server clears them. It uses the address the request comes from; behind a reverse proxy, Express's `trust proxy`
  setting would have to be configured first. It's off in the test suite (`NODE_ENV=test`), except in
  `tests/login-rate-limit.test.js`.

Failed logins and the lockout bookkeeping don't count as changes to the account: they leave `updated_at` alone, like a
successful login.

### Changing your own password: `POST /api/auth/change-password`

Any logged-in user, for their own account (the token says whose). Body: `{ currentPassword, newPassword }`, no other
fields.

- **The password rule** lives in one place, `newPassword` in `src/schemas/common.js`, and every check uses it. A new
  password needs at least 10 characters, a letter and a digit, and at most 72 characters (bcrypt ignores anything
  after 72 bytes). Each failed rule has its own message. Temporary passwords always pass it, and a test checks
  10,000 of them.
- **On success:** 200 `{ "message": "Password changed", "user": { ... } }`, with fresh session cookies. The new bcrypt hash,
  `must_change_password = false`, `updated_at` and a raised `session_version` are saved in one statement.
- **Wrong current password:** 400 `{ "message": "Current password is wrong", "code": "INVALID_CURRENT_PASSWORD" }`.
  This is 400, not 401, so clients don't mistake it for an expired session. Nothing changes, and the session stays.
- **Other errors:** 400 for a new password that breaks the rule or matches the current one, a missing field or an
  extra field. 401 without a valid session.
- **Sessions:** every other session of the user ends (see [When sessions end](#sessions-cookies-and-csrf)). The
  session that made the change continues as it is, cookies and all, so the person who changed it stays logged in.

### Creating an account: `POST /api/users`

Admins and HR only (anyone else gets 403, no token gets 401).

| Field           | Required                               | Notes                                                                            |
| --------------- | -------------------------------------- | -------------------------------------------------------------------------------- |
| `name`          | yes                                    | Up to 100 characters                                                             |
| `email`         | yes                                    | Must be unique; stored trimmed and lowercased                                    |
| `role`          | admins: yes. HR: no (means `employee`) | `employee`, `agent`, `hr` or `admin`. HR may only use `employee` (403 otherwise) |
| `department_id` | no                                     | Must be the id of a row in `departments`                                         |
| `job_title`     | no                                     | Up to 255 characters                                                             |

Any other field (such as `password`) is refused. The server makes the temporary password: 14 random letters and digits
from `crypto.randomInt`, hashed with bcrypt.

```http
POST /api/users
Cookie: tf_session=<admin or HR session>; tf_csrf=<csrf>
X-CSRF-Token: <csrf>

{ "name": "Teuta Krasniqi", "email": "teuta@ticketflow.local", "role": "employee", "department_id": 2, "job_title": "Accountant" }
```

```json
201 Created
{
  "user": {
    "id": 12, "name": "Teuta Krasniqi", "email": "teuta@ticketflow.local", "role": "employee",
    "department_id": 2, "department_name": "Finance", "job_title": "Accountant",
    "is_active": true, "must_change_password": true, "created_at": "2026-11-08T15:40:12.000Z"
  },
  "temporaryPassword": "k7RmQ2xWp9aHtB"
}
```

Errors: 409 if the email is taken (any letter case), and 400 `{ message, errors: [{ field, message }] }` for invalid
fields, a missing role from an admin, or a `department_id` that doesn't exist.

### Editing an account: `PATCH /api/users/:id`

Admins and HR only. Send at least one of `name`, `email`, `department_id`, `job_title`, `role`, `is_active`;
only those change. `null` clears `department_id` and `job_title`. Any other field
(`password`, `must_change_password`, `last_login_at`, `created_at`, ...) is refused by name.

The checks run in this order, and a request that fails one changes nothing:

1. 401 without a valid token, 403 for roles other than admin and HR, 400 if the id isn't a number
2. 404 if the user doesn't exist (even when the body is also wrong)
3. HR: 403 for any account that isn't an employee (including their own), and 403 if the body has a `role` at all
4. 400 for invalid fields or an empty body
5. 403 when admins change their own `role` or `is_active` (they can edit their own name, email and department)
6. 409 if the email belongs to another account (any letter case). Keeping your own email is fine
7. 400 if `department_id` doesn't exist
8. 409 if the change would leave no active admin. The admin rows are locked during the update, so two admins
   demoting each other at the same moment can't both succeed

```http
PATCH /api/users/12
Cookie: tf_session=<admin or HR session>; tf_csrf=<csrf>
X-CSRF-Token: <csrf>

{ "job_title": "Senior Accountant", "department_id": null }
```

```json
200 OK
{
  "id": 12, "name": "Teuta Krasniqi", "email": "teuta@ticketflow.local", "role": "employee",
  "department_id": null, "department_name": null, "job_title": "Senior Accountant", "is_active": true,
  "must_change_password": false, "last_login_at": null,
  "created_at": "2026-11-08T15:40:12.000Z", "updated_at": "2026-11-08T16:02:45.000Z"
}
```

### Resetting a password: `POST /api/users/:id/reset-password`

Admins and HR only, with no request body. Checks, in order:

1. 401 without a valid token, 403 for roles other than admin and HR
2. 403 for your own account (use `POST /api/auth/change-password`)
3. 404 if the user doesn't exist
4. 403 when HR resets anyone who isn't an employee
5. 400 if a body with any field is sent (the server always makes the password)

The new temporary password is made like the one for a new account. Only its bcrypt hash is stored, together with
`must_change_password = true` and a new `updated_at`, in one statement. The old password stops working at once.
Deactivated accounts can be reset too.

```json
200 OK
{
  "user": { "id": 12, "email": "teuta@ticketflow.local", "role": "employee", "must_change_password": true, ... },
  "temporaryPassword": "Hq4wZr8NpT2kXa"
}
```

**Sessions.** A reset ends every session the user had (401 on their next request). They log in again with the
temporary password. Deactivating a user or changing their role ends their sessions in the same way; see
[When sessions end](#sessions-cookies-and-csrf).

## Departments

Anyone logged in can list departments; admins and HR create, rename and delete them.

- **Names** are trimmed, with runs of spaces inside collapsed to one, and must be 1–100 characters. They are unique
  regardless of letter case: "Sales" and "sales" clash. The table's collation (`utf8mb4_unicode_ci`) makes the
  `UNIQUE` index on `name` case-insensitive, so the database guarantees this too. The same collation also treats
  accents as equal ("Café" and "Cafe" clash). A clash is 409 `DEPARTMENT_NAME_TAKEN`. Invalid names, a missing name
  and extra fields are 400 in the usual `{ message, errors }` format.
- **Renaming** to exactly the current name is a 200 that changes nothing. Changing only the letter case is a real
  rename.
- **Deleting** only works for a department nobody is in. Otherwise it's 409:

  ```json
  {
    "message": "Move the users out of this department before deleting it",
    "code": "DEPARTMENT_NOT_EMPTY",
    "user_count": 2
  }
  ```

  The check and the delete run in one transaction that locks the department row. A user being put into the department
  at the same moment is either counted (if their change came first) or refused with "Department not found" (if it
  came second). Without the lock, the `ON DELETE SET NULL` foreign key would silently take them out of it.

- An unknown id is 404 on rename and delete, checked before the body.

```json
GET /api/departments → 200
[
  { "id": 2, "name": "Finance", "user_count": 0, "created_at": "2026-11-08T17:10:00.000Z", "updated_at": "2026-11-08T17:10:00.000Z" },
  { "id": 1, "name": "IT", "user_count": 3, "created_at": "2026-11-08T17:09:12.000Z", "updated_at": "2026-11-08T17:09:12.000Z" }
]
```

`POST /api/departments { "name": "  Human   Resources " }` → 201 with `{ "id": 3, "name": "Human Resources", "user_count": 0, ... }`.

### From the old free-text department to departments (migration 005)

Users used to have a free-text `department`. Migration 005 turns those values into rows in `departments` and links
each user through `department_id`. The app now reads and writes only `department_id`; user responses include the
joined `department_name`, and sending `department` is refused like any other unknown field.

1. `npm run db:department-report` shows the raw values, the groups they will form, and likely near-duplicates
   ("Slaes" / "Sales", "HR" / "Human Resources"). Nothing is merged by guessing: add explicit merges to the mapping in
   `migrations/005_link_users_to_departments.sql` before running it.
2. `npm run db:migrate` applies it and prints a summary (departments created and reused, users linked, users left
   without one).
3. `npm run db:verify-departments` checks the result.

Values are trimmed, inner whitespace is collapsed, and case and accents are ignored. Empty values mean no department.
A group's name is its most common spelling. Existing departments are reused, and users who already had a
`department_id` are left alone. `npm run db:rollback` undoes exactly what 005 did, using its
`department_migration_005` table. The old `users.department` column is kept for now; a later migration will drop
it, together with that table.

## Ticket status flow

```
open → assigned → in_progress ⇄ waiting_for_user → resolved → closed
                                                       │          │
                                                       └→ reopened ←┘   (employee: "it's not fixed")
                                                            │
                                                            └→ assigned → in_progress → ...
```

- **open**: just created. Assigning someone moves it to **assigned** automatically.
- **in_progress** / **waiting_for_user**: the agent is working on it, or waiting for an answer from the employee.
- **resolved**: requires a resolution note; sets `resolved_at`.
- **closed**: the employee confirms the fix; sets `closed_at`.
- **reopened**: the problem came back. Assigning moves it to **assigned** again.

Moving a ticket back to an unfinished status clears `resolved_at` and `closed_at`, so it no longer counts as resolved
in the statistics. Moving a closed ticket back to **resolved** clears `closed_at`. The resolution note is kept.

Staff can set any status. Every change to status, priority or assignee is saved in `ticket_history`.
A ticket is **overdue** when it is not resolved/closed and is older than its priority's target time
(Low 120h, Medium 72h, High 24h, Critical 4h).

## API endpoints

All endpoints except health, login and logout need a session: the `tf_session` cookie (an `Authorization` header is
ignored). POST/PATCH/PUT/DELETE requests also need `X-CSRF-Token` equal to the `tf_csrf` cookie. See
[Sessions](#sessions-cookies-and-csrf).
Errors are always JSON with a `message` that can be shown to the user: `{ "message": "..." }`.

Invalid input gets status 400, and `errors` lists every problem by field. `message` is the first of them:

```json
{
  "message": "Title is required",
  "errors": [
    { "field": "title", "message": "Title is required" },
    { "field": "requester_id", "message": "requester_id is not allowed" }
  ]
}
```

Every body, `:id` and ticket list filter is checked with [zod](https://zod.dev/) before the route runs. Fields that
aren't listed for an endpoint are refused. An empty filter (`?status=`) means no filter.

| Method | Path                            | Who          | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------ | ------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/health`                   | anyone       | Health check → `{ status: "ok" }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| POST   | `/api/auth/login`               | anyone       | Log in `{ email, password }` → `{ user }`, and sets the `tf_session` and `tf_csrf` cookies (see [Sessions](#sessions-cookies-and-csrf)); sets `last_login_at`. With `must_change_password: true`, everything except `/api/auth/me` and change-password answers 403 `PASSWORD_CHANGE_REQUIRED`. 5 wrong passwords lock the account for 15 minutes (423 `ACCOUNT_LOCKED` with `retryAfterMinutes`); more than 20 requests per IP in 15 minutes get 429 `RATE_LIMITED`. See [Login limits](#login-limits-lockout-and-rate-limit) |
| POST   | `/api/auth/logout`              | anyone       | Ends this session on the server and clears the cookies → 204 (works without a valid session)                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| POST   | `/api/auth/logout-all`          | logged in    | Ends every session of the user, this one included, and clears the cookies → 204                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| GET    | `/api/auth/me`                  | logged in    | The current user: `{ id, name, email, role, department_id, department_name, job_title, created_at, last_login_at, must_change_password }` (`null` when empty; never the password hash). Login returns the same user object                                                                                                                                                                                                                                                                                                    |
| POST   | `/api/auth/change-password`     | logged in    | Change your password `{ currentPassword, newPassword }` → `{ message, user }`, with fresh session cookies; clears `must_change_password` and ends the user's other sessions (400 `INVALID_CURRENT_PASSWORD` if the current password is wrong). See [Changing your own password](#changing-your-own-password-post-apiauthchange-password)                                                                                                                                                                                      |
| GET    | `/api/meta`                     | logged in    | Categories and priorities (for dropdowns)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| GET    | `/api/tickets`                  | logged in    | List tickets (employees: own only). Filters: `status`, `priority`, `category`, `assigned=me\|unassigned`, `q`, `overdue=1`                                                                                                                                                                                                                                                                                                                                                                                                    |
| POST   | `/api/tickets`                  | logged in    | Create a ticket `{ title, description, category_id, priority_id }`                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| GET    | `/api/tickets/:id`              | logged in    | One ticket with comments and history (employees: own tickets, no internal notes)                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| POST   | `/api/tickets/:id/comments`     | logged in    | Add a comment `{ content, is_internal? }` (internal notes: staff only)                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| PATCH  | `/api/tickets/:id/status`       | logged in    | Change status `{ status, resolution? }` (employees: only close or reopen)                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| PATCH  | `/api/tickets/:id/priority`     | agent, admin | Change priority `{ priority_id }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| PATCH  | `/api/tickets/:id/assign`       | agent, admin | Assign `{ assigned_to }` (`null` = unassign; agents can only assign themselves)                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| GET    | `/api/users/agents`             | agent, admin | Active agents and admins (for the "Assign to" dropdown)                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| GET    | `/api/users`                    | admin, hr    | All users                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| POST   | `/api/users`                    | admin, hr    | Create an account `{ name, email, role, department_id?, job_title? }` → `{ user, temporaryPassword }` (HR: employees only, role optional). See [Creating an account](#creating-an-account-post-apiusers)                                                                                                                                                                                                                                                                                                                      |
| POST   | `/api/users/:id/reset-password` | admin, hr    | No body. New temporary password → `{ user, temporaryPassword }`; sets `must_change_password` and unlocks a locked account (not your own account: 403; HR: employees only). See [Resetting a password](#resetting-a-password-post-apiusersidreset-password)                                                                                                                                                                                                                                                                    |
| PATCH  | `/api/users/:id`                | admin, hr    | Change `{ name?, email?, department_id?, job_title?, role?, is_active? }` (at least one). Admin: anyone, but not their own role/active status, and never the last active admin. HR: employees only, never `role`. See [Editing an account](#editing-an-account-patch-apiusersid)                                                                                                                                                                                                                                              |
| GET    | `/api/stats`                    | admin        | Dashboard statistics: totals, by status/priority/category/agent, 8-week trend                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| GET    | `/api/departments`              | logged in    | All departments, sorted by name, with `user_count`                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| POST   | `/api/departments`              | admin, hr    | Create `{ name }` → 201 the department (409 `DEPARTMENT_NAME_TAKEN`)                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| PATCH  | `/api/departments/:id`          | admin, hr    | Rename `{ name }` → the department (409 `DEPARTMENT_NAME_TAKEN`)                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| DELETE | `/api/departments/:id`          | admin, hr    | Delete an empty department → 204 (409 `DEPARTMENT_NOT_EMPTY` with `user_count`). See [Departments](#departments)                                                                                                                                                                                                                                                                                                                                                                                                              |

A Postman collection with every request is in [`docs/TicketFlow.postman_collection.json`](docs/TicketFlow.postman_collection.json).
Import it, run one of the **Login** requests (Postman keeps the session cookies, and the collection sends `tf_csrf` as
`X-CSRF-Token` on changes by itself), then try the other requests. **Logout** clears the cookies.
Log in as the admin to be allowed every request. Requests that change data (create, status, assign, ...) modify
the demo data; see [Backups and reseeding](#backups-and-reseeding) to reset it.

## Project structure

```
docs/
  TicketFlow.postman_collection.json   Postman collection for every endpoint
migrations/
  001_initial.sql         The original tables; later changes go in new numbered files
  005_link_users_to_departments.sql   Turns the free-text department into departments
  down/                   Rollback files, named like the migration they undo (npm run db:rollback)
scripts/
  migrate.js              Creates the database and applies new migrations (npm run db:migrate)
  rollback.js             Undoes the most recent migration (npm run db:rollback)
  seed.js                 Wipes all tables and inserts demo data, departments included (npm run db:seed)
  backup-db.js            Writes a SQL backup to backups/ (npm run db:backup)
  department-report.js    Read-only report on the free-text departments (npm run db:department-report)
  verify-department-migration.js   Checks migration 005 (npm run db:verify-departments)
  reference-data.js       The categories and priorities (used by seed.js and the tests)
src/
  server.js               Entry point: loads .env and starts the server
  app.js                  Express app: middleware, routes, error handling
  db.js                   MySQL connection pool
  overdue.js              The shared "is this ticket overdue?" SQL rule
  temporaryPassword.js    Random temporary passwords for created and reset accounts
  middleware/
    auth.js               requireAuth, requireRole, isStaff
    errors.js             HttpError, 404 handler, central error handler
    validate.js           Checks a request against zod schemas; results go in req.valid
  schemas/
    common.js             Shared pieces: id, email, name, password, status, role
    auth.js, tickets.js, comments.js, users.js   What each endpoint accepts
  routes/
    index.js              The list of routers and their paths (app.js mounts these)
    auth.js               /api/auth: login, me, change password
    meta.js               /api/meta: categories and priorities
    tickets.js            /api/tickets: list, create, view, comments, status, priority, assign
    users.js              /api/users: agent list, creating accounts, user management
    stats.js              /api/stats: dashboard statistics
    departments.js        /api/departments: list, create, rename, delete
tests/
  globalSetup.js          Creates the throwaway test database before all tests
  globalTeardown.js       Drops it after all tests
  setupEnv.js             Points the app at the test database before it loads
  setupAfterEnv.js        Closes the MySQL pool after each test file
  helpers.js              api, resetData, createUser, loginAs, createDepartment, createCallers, expectError,
                          expectNoPasswordHash, dbSnapshot (every table, for "nothing changed" checks)
  testDb.js               Test database name rules and safety guard
  smoke.test.js           Smoke test proving the setup works
  matrix.test.js          Permission matrix: every endpoint × caller; refusals leave the database unchanged
  users.test.js           Creating, listing and editing users
  reset-password.test.js  Admin/HR password resets
  change-password.test.js Changing your own password and the password rule
  auth-enforcement.test.js  Login, no self-signup, and the temporary-password block on every route
  departments.test.js     Departments, including deleting while a user is being assigned
  migrations.test.js      Schema, up/down/up, and migration 005 on messy data
  seed.test.js            The demo seed, run twice
jest.config.js            Jest settings
.env.example              Example configuration (copy to .env)
TASKS.md                  Development task list
```

## Database tables

| Table               | Contents                                                                                                                                                                                                                                                                                                        |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `users`             | Accounts: name, email, password hash, role (employee/agent/hr/admin), department_id, job title, active flag, last login, wrong-password count and lock (`failed_login_count`, `locked_until`), `session_version` (raising it ends the user's sessions). `department` is the old free-text value, no longer used |
| `departments`       | Departments people belong to; `users.department_id` links to them (see [Departments](#departments))                                                                                                                                                                                                             |
| `categories`        | Ticket categories (Hardware, Software, Network, Access, Email, Other)                                                                                                                                                                                                                                           |
| `priorities`        | Priority levels with their target resolution time in hours                                                                                                                                                                                                                                                      |
| `tickets`           | Tickets: requester, assignee, category, priority, status, resolution note, timestamps                                                                                                                                                                                                                           |
| `comments`          | Comments on tickets; `is_internal` marks staff-only notes                                                                                                                                                                                                                                                       |
| `ticket_history`    | Audit trail: who changed which field (status, priority, assignee) from what to what, and when                                                                                                                                                                                                                   |
| `sessions`          | One row per login (migration 008): `user_id`, `created_at`, `expires_at`, `revoked_at`, `last_seen_at`, `ip`, `user_agent`. The token's `sid` is the row id. Rows are deleted 7 days after they end                                                                                                             |
| `schema_migrations` | Which migrations this database has run, and when                                                                                                                                                                                                                                                                |
