# TicketFlow Backend

TicketFlow is an IT helpdesk / ticketing system. Employees report IT problems as tickets, agents pick them up,
work on them and resolve them, and admins manage users and follow the team's performance on a statistics dashboard.

This repository is the REST API. The frontend lives in a separate repository: **ticketflow-frontend**.

## Tech stack

- **Node.js** + **Express 5**: REST API
- **MySQL 8** with **mysql2**: database (connection pool, `?` placeholders for every query)
- **jsonwebtoken**: login tokens (JWT, sent as `Authorization: Bearer <token>`)
- **bcryptjs**: password hashing
- **helmet**, **cors**: security headers and allowing the frontend origin
- **dotenv**: configuration from `.env`
- **nodemon**: auto-restart during development

## Requirements

- Node.js 18 or newer
- MySQL 8 running locally, **or** XAMPP (MariaDB 10.4 or newer). Both work with the same code and scripts.

## Setup

```bash
npm install
cp .env.example .env
```

Edit `.env`: set `DB_PASSWORD` to your MySQL root password (leave it empty if root has none) and set `JWT_SECRET`
to a long random string.

> **Using XAMPP?** Start MySQL from the XAMPP Control Panel. XAMPP's root user has no password by default, so
> leave it empty: `DB_PASSWORD=` (nothing after the `=`). If you put any value there, `npm run db:migrate` cannot connect.

```bash
npm run db:migrate   # creates the "ticketflow" database and all tables
npm run db:seed      # fills the empty database with demo data
npm run dev          # starts the API with auto-reload
```

The API runs on **http://localhost:5050**. Check it with http://localhost:5050/api/health → `{ "status": "ok" }`.
(Port 5000 is not used because macOS AirPlay occupies it.)

| Script               | Description                                    |
| -------------------- | ---------------------------------------------- |
| `npm start`          | Start the server                               |
| `npm run dev`        | Start with nodemon (auto-reload)               |
| `npm run db:migrate` | Create the database or apply new migrations    |
| `npm run db:seed`    | Insert the demo data (empty database only)     |
| `npm run db:rollback` | Undo the most recent migration (backs up first) |
| `npm run db:backup`  | Back up the database to `backups/`             |

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

## Demo accounts

All demo accounts use the password **`password123`**.

| Name           | Email                        | Role     |
| -------------- | ---------------------------- | -------- |
| Admin User     | `admin@ticketflow.local`     | admin    |
| Arben Krasniqi | `agent1@ticketflow.local`    | agent    |
| Drita Berisha  | `agent2@ticketflow.local`    | agent    |
| Liridon Gashi  | `employee1@ticketflow.local` | employee |
| Vjosa Hoxha    | `employee2@ticketflow.local` | employee |

## Roles

- **Employee**: creates tickets and sees only their own. Can comment on them (never internal notes), close a
  resolved ticket, or reopen a resolved/closed one.
- **Agent**: sees all tickets, takes tickets (assigns them to themselves), changes status and priority, and writes
  public comments and internal notes. Cannot assign tickets to other people.
- **HR**: creates employee accounts, edits their name, email and department, resets their passwords, and
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

- **Login still works** for a flagged user. The response carries the flag next to the token,
  `{ token, must_change_password, user }`, so the client knows to show its change-password screen right away. A
  successful login also sets `last_login_at`; failed attempts don't.
- **One check, on every authenticated route.** `requireAuth` (in `src/middleware/auth.js`) runs on every route
  except `POST /api/auth/login` and `GET /api/health`. It loads the user from the database on each request, so the
  flag is always current: a reset blocks the user on their next request, even with a token from before the reset,
  and changing the password unblocks the same token at once. A missing or invalid token is still a 401, checked
  first.
- **The allowlist** is `ALLOWED_BEFORE_PASSWORD_CHANGE` in the same file: exactly `GET /api/auth/me` and
  `POST /api/auth/change-password`. Matching is exact method and path; a trailing slash counts as the same path. There
  is no logout or token refresh endpoint.
- **Routers** are mounted from the one list in `src/routes/index.js`. `tests/routes.test.js` walks every route in that
  list and fails if one doesn't need a login or doesn't block a flagged user.

The frontend uses `code` to send the user to its "Set your password" page. A new password needs 10–72 characters with
at least one letter and one number, and must differ from the current one.

### Changing your own password: `POST /api/auth/change-password`

Any logged-in user, for their own account (the token says whose). Body: `{ currentPassword, newPassword }`, no other
fields.

- **The password rule** lives in one place, `newPassword` in `src/schemas/common.js`, and every check uses it. A new
  password needs at least 10 characters, a letter and a digit, and at most 72 characters (bcrypt ignores anything
  after 72 bytes). Each failed rule has its own message. Temporary passwords always pass it, and a test checks
  10,000 of them.
- **On success:** 200 `{ "message": "Password changed", "user": { ... } }`. The new bcrypt hash,
  `must_change_password = false` and `updated_at` are saved in one statement.
- **Wrong current password:** 400 `{ "message": "Current password is wrong", "code": "INVALID_CURRENT_PASSWORD" }`.
  This is 400, not 401, so clients don't mistake it for an expired session. Nothing changes, and the session stays.
- **Other errors:** 400 for a new password that breaks the rule or matches the current one, a missing field or an
  extra field. 401 without a valid token.
- **Sessions:** logins are stateless JWTs that can't be revoked, so other sessions keep working until they expire
  (`JWT_EXPIRES_IN`). The token used for the change stays valid. There is no logout endpoint: logging out only
  forgets the token in the browser.

### Creating an account: `POST /api/users`

Admins and HR only (anyone else gets 403, no token gets 401).

| Field           | Required                                | Notes                                                        |
| --------------- | --------------------------------------- | ------------------------------------------------------------ |
| `name`          | yes                                     | Up to 100 characters                                         |
| `email`         | yes                                     | Must be unique; stored trimmed and lowercased                |
| `role`          | admins: yes. HR: no (means `employee`)  | `employee`, `agent`, `hr` or `admin`. HR may only use `employee` (403 otherwise) |
| `department_id` | no                                      | Must be the id of a row in `departments`                     |
| `job_title`     | no                                      | Up to 255 characters                                         |
| `department`    | no                                      | The older free-text department, up to 100 characters         |

Any other field (such as `password`) is refused. The server makes the temporary password: 14 random letters and digits
from `crypto.randomInt`, hashed with bcrypt.

```http
POST /api/users
Authorization: Bearer <admin or HR token>

{ "name": "Teuta Krasniqi", "email": "teuta@ticketflow.local", "role": "employee", "department_id": 2, "job_title": "Accountant" }
```

```json
201 Created
{
  "user": {
    "id": 12, "name": "Teuta Krasniqi", "email": "teuta@ticketflow.local", "role": "employee",
    "department": null, "department_id": 2, "job_title": "Accountant",
    "is_active": true, "must_change_password": true, "created_at": "2026-11-08T15:40:12.000Z"
  },
  "temporaryPassword": "k7RmQ2xWp9aHtB"
}
```

Errors: 409 if the email is taken (any letter case), and 400 `{ message, errors: [{ field, message }] }` for invalid
fields, a missing role from an admin, or a `department_id` that doesn't exist.

### Editing an account: `PATCH /api/users/:id`

Admins and HR only. Send at least one of `name`, `email`, `department`, `department_id`, `job_title`, `role`,
`is_active`; only those change. `null` clears `department`, `department_id` and `job_title`. Any other field
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
Authorization: Bearer <admin or HR token>

{ "job_title": "Senior Accountant", "department_id": null }
```

```json
200 OK
{
  "id": 12, "name": "Teuta Krasniqi", "email": "teuta@ticketflow.local", "role": "employee",
  "department": null, "department_id": null, "job_title": "Senior Accountant", "is_active": true,
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

**Sessions.** Logins are stateless JWTs (valid for `JWT_EXPIRES_IN`, 1 day by default) with no revocation list.
Even so, a session from before the reset can do nothing: every request reloads the user, and while
`must_change_password` is set only `GET /api/auth/me` and `POST /api/auth/change-password` work, and the latter needs
the new temporary password. Once the user has chosen a new password, though, older tokens work again until they
expire. Ending them for good would need a per-user token version or "valid after" time in the JWT.

Role changes and deactivation take effect immediately: every request checks the user's current role and active
status in the database.

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

All endpoints except health and login need `Authorization: Bearer <token>`.
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

| Method | Path                            | Who                 | What it does                                                                                    |
| ------ | ------------------------------- | ------------------- | ----------------------------------------------------------------------------------------------- |
| GET    | `/api/health`                   | anyone              | Health check → `{ status: "ok" }`                                                               |
| POST   | `/api/auth/login`               | anyone              | Log in `{ email, password }` → `{ token, must_change_password, user }`; sets `last_login_at`. With `must_change_password: true`, everything except `/api/auth/me` and change-password answers 403 `PASSWORD_CHANGE_REQUIRED` |
| GET    | `/api/auth/me`                  | logged in           | The current user                                                                                |
| POST   | `/api/auth/change-password`     | logged in           | Change your password `{ currentPassword, newPassword }` → `{ message, user }`; clears `must_change_password` (400 `INVALID_CURRENT_PASSWORD` if the current password is wrong). See [Changing your own password](#changing-your-own-password-post-apiauthchange-password) |
| GET    | `/api/meta`                     | logged in           | Categories and priorities (for dropdowns)                                                       |
| GET    | `/api/tickets`                  | logged in           | List tickets (employees: own only). Filters: `status`, `priority`, `category`, `assigned=me\|unassigned`, `q`, `overdue=1` |
| POST   | `/api/tickets`                  | logged in           | Create a ticket `{ title, description, category_id, priority_id }`                              |
| GET    | `/api/tickets/:id`              | logged in           | One ticket with comments and history (employees: own tickets, no internal notes)                |
| POST   | `/api/tickets/:id/comments`     | logged in           | Add a comment `{ content, is_internal? }` (internal notes: staff only)                          |
| PATCH  | `/api/tickets/:id/status`       | logged in           | Change status `{ status, resolution? }` (employees: only close or reopen)                       |
| PATCH  | `/api/tickets/:id/priority`     | agent, admin        | Change priority `{ priority_id }`                                                               |
| PATCH  | `/api/tickets/:id/assign`       | agent, admin        | Assign `{ assigned_to }` (`null` = unassign; agents can only assign themselves)                 |
| GET    | `/api/users/agents`             | agent, admin        | Active agents and admins (for the "Assign to" dropdown)                                         |
| GET    | `/api/users`                    | admin, hr           | All users                                                                                       |
| POST   | `/api/users`                    | admin, hr           | Create an account `{ name, email, role, department_id?, job_title?, department? }` → `{ user, temporaryPassword }` (HR: employees only, role optional). See [Creating an account](#creating-an-account-post-apiusers) |
| POST   | `/api/users/:id/reset-password` | admin, hr        | No body. New temporary password → `{ user, temporaryPassword }`; sets `must_change_password` (not your own account: 403; HR: employees only). See [Resetting a password](#resetting-a-password-post-apiusersidreset-password) |
| PATCH  | `/api/users/:id`                | admin, hr           | Change `{ name?, email?, department?, department_id?, job_title?, role?, is_active? }` (at least one). Admin: anyone, but not their own role/active status, and never the last active admin. HR: employees only, never `role`. See [Editing an account](#editing-an-account-patch-apiusersid) |
| GET    | `/api/stats`                    | admin               | Dashboard statistics: totals, by status/priority/category/agent, 8-week trend                   |

A Postman collection with every request is in [`docs/TicketFlow.postman_collection.json`](docs/TicketFlow.postman_collection.json).
Import it, run one of the **Login** requests (it saves the token automatically), then try the other requests.
Log in as the admin to be allowed every request. Requests that change data (create, status, assign, ...) modify
the demo data; see [Backups and reseeding](#backups-and-reseeding) to reset it.

## Project structure

```
docs/
  TicketFlow.postman_collection.json   Postman collection for every endpoint
migrations/
  001_initial.sql         The original tables; later changes go in new numbered files
  down/                   Rollback files, named like the migration they undo (npm run db:rollback)
scripts/
  migrate.js              Creates the database and applies new migrations (npm run db:migrate)
  rollback.js             Undoes the most recent migration (npm run db:rollback)
  seed.js                 Wipes all tables and inserts demo data (npm run db:seed)
  backup-db.js            Writes a SQL backup to backups/ (npm run db:backup)
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
tests/
  globalSetup.js          Creates the throwaway test database before all tests
  globalTeardown.js       Drops it after all tests
  setupEnv.js             Points the app at the test database before it loads
  setupAfterEnv.js        Closes the MySQL pool after each test file
  helpers.js              api, resetData, createUser, loginAs
  testDb.js               Test database name rules and safety guard
  smoke.test.js           Smoke test proving the setup works
  routes.test.js          Every route needs a login and blocks users with a temporary password
jest.config.js            Jest settings
.env.example              Example configuration (copy to .env)
TASKS.md                  Development task list
```

## Database tables

| Table            | Contents                                                                                     |
| ---------------- | -------------------------------------------------------------------------------------------- |
| `users`          | Accounts: name, email, password hash, role (employee/agent/admin), department, active flag   |
| `departments`    | Departments (not used by the app yet; `users.department_id` links to them)                   |
| `categories`     | Ticket categories (Hardware, Software, Network, Access, Email, Other)                         |
| `priorities`     | Priority levels with their target resolution time in hours                                   |
| `tickets`        | Tickets: requester, assignee, category, priority, status, resolution note, timestamps        |
| `comments`       | Comments on tickets; `is_internal` marks staff-only notes                                    |
| `ticket_history` | Audit trail: who changed which field (status, priority, assignee) from what to what, and when |
| `schema_migrations` | Which migrations this database has run, and when                                           |
