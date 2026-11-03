# TicketFlow Backend

REST API for TicketFlow, an IT helpdesk / ticketing system.

## Stack

- Node.js
- Express
- MySQL (via `mysql2`)

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```
2. Create your environment file and fill in your MySQL credentials and a JWT secret:
   ```bash
   cp .env.example .env
   ```
3. Start the dev server (auto-restarts on changes):
   ```bash
   npm run dev
   ```
4. Check it's running: http://localhost:5050/api/health should return `{ "status": "ok" }`.

## Scripts

| Script             | Description                       |
| ------------------ | --------------------------------- |
| `npm start`        | Start the server                  |
| `npm run dev`      | Start with nodemon (auto-reload)  |
| `npm run db:setup` | Create the database and tables    |
| `npm run db:seed`  | Insert sample data                |
