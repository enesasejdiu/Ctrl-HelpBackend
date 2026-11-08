-- Undoes migrations/006_login_lockout.sql. Run with npm run db:rollback, which backs up first.
-- Only the lockout state is lost (wrong-password counts and current locks): every account is unlocked.
ALTER TABLE users
  DROP COLUMN failed_login_count,
  DROP COLUMN locked_until;
