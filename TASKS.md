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

## Phase 4 – Authentication
- [x] `POST /api/auth/register`: validates input, checks the email is unique, hashes the password, creates an employee, returns `{ token, user }`
- [x] `POST /api/auth/login`: checks the password and that the account is active, returns `{ token, user }`
- [x] `GET /api/auth/me`: returns the current user
- [x] Never return `password_hash` in any response
- [x] Test all three in Postman

## Phase 5 – Tickets
- [ ] `GET /api/meta` returns categories and priorities
- [ ] `GET /api/tickets`: employees see only their own, staff see all
- [ ] Filters: status, priority, category, assigned=me|unassigned, q (search), overdue=1
- [ ] Include requester_name, assignee_name, category_name, priority_name, target_hours, is_overdue
- [ ] Sort by priority (highest first), then newest
- [ ] `POST /api/tickets` creates a ticket and logs "status: open" in history
- [ ] `GET /api/tickets/:id` returns the ticket + comments + history (employees: own tickets only, no internal notes)
- [ ] `PATCH /api/tickets/:id/status`
  - [ ] Staff can set any status
  - [ ] Employees can only close a resolved ticket or reopen a resolved/closed one
  - [ ] Resolving requires a resolution note
  - [ ] Set resolved_at / closed_at automatically; clear them on reopen
- [ ] `PATCH /api/tickets/:id/priority` (staff only)
- [ ] `PATCH /api/tickets/:id/assign`
  - [ ] Admin can assign anyone; an agent can only assign to themselves
  - [ ] An open/reopened ticket becomes "assigned"
- [ ] Every change to status, priority or assignee is saved in `ticket_history`
- [ ] Test the full lifecycle in Postman: open → assigned → in_progress → resolved → closed → reopened

## Phase 6 – Comments
- [ ] `POST /api/tickets/:id/comments` with `{ content, is_internal }`
- [ ] Only staff can create internal notes
- [ ] Empty comments are rejected

## Phase 7 – Users (admin)
- [ ] `GET /api/users/agents`: active agents and admins (for the assign dropdown)
- [ ] `GET /api/users`: all users (admin only)
- [ ] `PATCH /api/users/:id`: change role or activate/deactivate (admins cannot change their own account)

## Phase 8 – Statistics (admin)
- [ ] `GET /api/stats` returns:
  - [ ] total tickets and count by status
  - [ ] average resolution time (hours) and resolved count
  - [ ] overdue count
  - [ ] by priority: count, target hours, average hours
  - [ ] by category: count
  - [ ] by agent: assigned, resolved, average hours
  - [ ] trend: created vs resolved per week (last 8 weeks)

## Phase 9 – Seed data
- [ ] `scripts/seed.js` clears all tables first
- [ ] 6 categories and 4 priorities (Low 120h, Medium 72h, High 24h, Critical 4h)
- [ ] 5 users, password `password123`: admin@, agent1@, agent2@, employee1@, employee2@ticketflow.local
- [ ] About 8 realistic tickets in different statuses, including some resolved and some overdue
- [ ] A few comments, including one internal note
- [ ] Test: `npm run db:seed`, then log in with every demo account

## Phase 10 – Finish
- [ ] Every query uses `?` placeholders (no SQL injection)
- [ ] Every route is protected with the right role
- [ ] README: setup steps, demo accounts, endpoint table
- [ ] Comments in the code explaining the important parts
- [ ] Export the Postman collection to `docs/` (optional)
- [ ] Final commit and push
