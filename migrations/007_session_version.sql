-- Session revocation: every login token carries the user's session_version, and requireAuth refuses a token whose
-- version no longer matches this column. Raising it ends every existing session of that user at once.
-- Raised when the user changes their password (their own session gets a fresh token), an admin or HR resets it,
-- the account is deactivated, or the role changes. Logout doesn't raise it (it only clears that browser's cookie).
-- A plain ADD COLUMN, so it runs the same on MySQL 8/9 and MariaDB. Existing users start at 0.
-- Tokens issued before this migration have no version and are treated as version 0, so nobody is logged out by it.
-- Undone by migrations/down/007_session_version.sql.
ALTER TABLE users
  ADD COLUMN session_version INT NOT NULL DEFAULT 0 AFTER locked_until;
