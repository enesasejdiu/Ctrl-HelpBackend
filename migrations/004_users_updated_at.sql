-- Adds users.updated_at: when the account row last changed (profile edits, role, active status, password).
-- Existing users start with the time this migration runs. Undone by migrations/down/004_users_updated_at.sql.
ALTER TABLE users
  ADD COLUMN updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP AFTER created_at;
