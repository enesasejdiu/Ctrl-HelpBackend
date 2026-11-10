-- Undoes migrations/008_password_setup_tokens.sql. Run with npm run db:rollback, which backs up first.
-- Set-password links that were sent and not used yet stop working; send a new one after migrating again, or reset
-- the password instead.
DROP TABLE IF EXISTS password_setup_tokens;
