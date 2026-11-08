-- Undoes migrations/004_users_updated_at.sql. Run with npm run db:rollback, which backs up first.
-- Only the timestamps are lost; nothing else in users changes.
ALTER TABLE users DROP COLUMN updated_at;
