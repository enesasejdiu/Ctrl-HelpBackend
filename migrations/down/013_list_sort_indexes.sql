-- Undoes migrations/013_list_sort_indexes.sql. Run with npm run db:rollback, which backs up first.
-- Drops only the indexes; no data changes.
ALTER TABLE tickets
  DROP INDEX idx_tickets_created,
  DROP INDEX idx_tickets_updated,
  DROP INDEX idx_tickets_title;

ALTER TABLE users
  DROP INDEX idx_users_created,
  DROP INDEX idx_users_name;
