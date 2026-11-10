-- Undoes migrations/008_sessions.sql. Run with npm run db:rollback, which backs up first.
-- Every session row is lost, so after the code that needs them is rolled back too, users simply log in again.
DROP TABLE sessions;
