-- Login lockout: counts wrong passwords per account and locks it for a while after too many (see POST /api/auth/login).
-- failed_login_count: wrong passwords since the last successful login (or since the last lock ran out).
-- locked_until: while this is in the future, login is refused even with the right password; NULL = not locked.
-- Plain ADD COLUMNs: no data is read or grouped, so this runs the same on MySQL 8/9 and MariaDB.
-- Existing users start unlocked with a count of 0. Undone by migrations/down/006_login_lockout.sql.
ALTER TABLE users
  ADD COLUMN failed_login_count INT NOT NULL DEFAULT 0 AFTER last_login_at,
  ADD COLUMN locked_until DATETIME NULL AFTER failed_login_count;
