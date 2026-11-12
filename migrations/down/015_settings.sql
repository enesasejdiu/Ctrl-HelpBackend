-- Undoes migrations/015_settings.sql. Run with npm run db:rollback, which backs up first.
-- DELETES DATA: the settings table (the company name goes back to the built-in "TicketFlow"), and which categories
-- and priorities were archived, their order and the default priority. The categories and priorities themselves stay,
-- and so does every ticket's link to them (rows added by 015 into an empty database stay too).
DROP TABLE settings;

ALTER TABLE priorities
  DROP INDEX uq_priorities_default,
  DROP INDEX uq_priorities_level,
  DROP COLUMN updated_at,
  DROP COLUMN created_at,
  DROP COLUMN is_active,
  DROP COLUMN default_key,
  DROP COLUMN is_default;

ALTER TABLE categories
  DROP COLUMN updated_at,
  DROP COLUMN created_at,
  DROP COLUMN is_active,
  DROP COLUMN sort_order;
