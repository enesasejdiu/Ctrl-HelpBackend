# TicketFlow Backend – Tasks

Node.js + Express + MySQL REST API. Work through the phases in order and tick each box when it is done and tested.

## Phase 1 – Project setup
Note: the API runs on port 5050 (5000 is used by macOS AirPlay).

- [x] Run `npm init` and set the name to `ticketflow-backend`
- [x] Install dependencies: `express mysql2 jsonwebtoken bcryptjs cors helmet dotenv`
- [x] Install dev dependency: `nodemon`
- [x] Add npm scripts: `start`, `dev`, `db:setup`, `db:seed`
- [x] Create `.gitignore` (node_modules, .env)
- [x] Create `.env.example` (PORT, DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME, JWT_SECRET, JWT_EXPIRES_IN, CLIENT_URL)
- [x] Create folders: `db/`, `scripts/`, `src/middleware/`, `src/routes/`
- [x] `src/server.js` starts the app on PORT
- [x] `src/app.js` with helmet, cors (CLIENT_URL), express.json()
- [x] `GET /api/health` returns `{ status: "ok" }`

## Phase 2 – Database
- [x] `db/schema.sql` with tables: users, categories, priorities, tickets, comments, ticket_history
- [x] Foreign keys between all related tables
- [x] Ticket status ENUM: open, assigned, in_progress, waiting_for_user, resolved, closed, reopened
- [x] User role ENUM: employee, agent, admin
- [x] `src/db.js` MySQL connection pool (mysql2/promise)
- [x] `scripts/setup-db.js` creates the database and runs schema.sql
- [x] Test: `npm run db:setup` creates all tables

## Phase 3 – Error handling and auth middleware
- [x] `src/middleware/errors.js`: HttpError class, 404 handler, central error handler returning `{ message }`
- [x] `src/middleware/auth.js`: `requireAuth` (reads Bearer token, sets `req.user`)
- [x] `requireRole(...roles)` returns 403 for the wrong role
- [x] `isStaff(user)` helper (agent or admin)

requireAuth checks the current role and active status in the database on every request (added in Phase 8).

## Phase 4 – Authentication
- [x] ~~`POST /api/auth/register`~~: removed in v1.0. Admins and HR create accounts with `POST /api/users`
- [x] `POST /api/auth/login`: checks the password and that the account is active, returns `{ token, user }`
- [x] `GET /api/auth/me`: returns the current user
- [x] Never return `password_hash` in any response
- [x] Test all three in Postman

## Phase 5 – Tickets
- [x] `GET /api/meta` returns categories and priorities
- [x] `GET /api/tickets`: employees see only their own, staff see all
- [x] Filters: status, priority, category, assigned=me|unassigned, q (search), overdue=1
- [x] Include requester_name, assignee_name, category_name, priority_name, target_hours, is_overdue
- [x] Sort by priority (highest first), then newest
- [x] `POST /api/tickets` creates a ticket and logs "status: open" in history
- [x] `GET /api/tickets/:id` returns the ticket + comments + history (employees: own tickets only, no internal notes)
- [x] `PATCH /api/tickets/:id/status`
  - [x] Staff can set any status
  - [x] Employees can only close a resolved ticket or reopen a resolved/closed one
  - [x] Resolving requires a resolution note
  - [x] Set resolved_at / closed_at automatically; clear them on reopen
- [x] `PATCH /api/tickets/:id/priority` (staff only)
- [x] `PATCH /api/tickets/:id/assign`
  - [x] Admin can assign anyone; an agent can only assign to themselves
  - [x] An open/reopened ticket becomes "assigned"
- [x] Every change to status, priority or assignee is saved in `ticket_history`
- [x] Test the full lifecycle in Postman: open → assigned → in_progress → resolved → closed → reopened

## Phase 6 – Comments
- [x] `POST /api/tickets/:id/comments` with `{ content, is_internal }`
- [x] Only staff can create internal notes
- [x] Empty comments are rejected

## Phase 7 – Users (admin)
- [x] `GET /api/users/agents`: active agents and admins (for the assign dropdown)
- [x] `GET /api/users`: all users (admin only)
- [x] `PATCH /api/users/:id`: change role or activate/deactivate (admins cannot change their own account)
- [x] Demoting or deactivating an agent/admin unassigns their unfinished tickets (logged in ticket history)

## Phase 8 – Statistics (admin)
- [x] `GET /api/stats` returns:
  - [x] total tickets and count by status
  - [x] average resolution time (hours) and resolved count
  - [x] overdue count
  - [x] by priority: count, target hours, average hours
  - [x] by category: count
  - [x] by agent: assigned, resolved, average hours
  - [x] trend: created vs resolved per week (last 8 weeks)

## Phase 9 – Seed data
- [x] `scripts/seed.js` clears all tables first
- [x] 6 categories and 4 priorities (Low 120h, Medium 72h, High 24h, Critical 4h)
- [x] 5 users, password `password123`: admin@, agent1@, agent2@, employee1@, employee2@ticketflow.local
- [x] About 8 realistic tickets in different statuses, including some resolved and some overdue
- [x] A few comments, including one internal note
- [x] Test: `npm run db:seed`, then log in with every demo account

## Phase 10 – Finish
- [x] Every query uses `?` placeholders (no SQL injection)
- [x] Every route is protected with the right role
- [x] README: setup steps, demo accounts, endpoint table
- [x] Comments in the code explaining the important parts
- [x] Export the Postman collection to `docs/` (optional)
- [x] Final commit and push

## v1.0

- [x] Add input validation with a library (zod) on every endpoint, with clear 400 messages
- [x] Jest + Supertest with an automatic test database
- [x] HR role; Admin/HR create users with a temporary password; self-registration removed (backend)
- [x] Change password endpoint; users with a temporary password are blocked until they change it
- [x] Admin/HR reset a user's password
- [x] Admin/HR edit name, email and department (backend)
- [x] /me returns job title, member since and last login; login records last_login_at
