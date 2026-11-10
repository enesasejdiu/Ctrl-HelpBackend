-- Undoes migrations/007_session_version.sql. Run with npm run db:rollback, which backs up first.
-- Only the session versions are lost: tokens that were ended by a password change, reset, deactivation or role change
-- work again until they expire (at most 8 hours after login).
ALTER TABLE users
  DROP COLUMN session_version;
