-- Undoes migrations/016_auto_close.sql. Run with npm run db:rollback, which backs up first.
-- The system's (the auto-close job's) history rows have no user and can't exist with changed_by NOT NULL again, so
-- they are deleted; the tickets themselves stay closed. The resolved_at values the backfill set stay too (they are
-- correct times either way). The auto_close_days setting is removed.
DELETE FROM ticket_history WHERE changed_by IS NULL;

ALTER TABLE ticket_history
  MODIFY COLUMN changed_by INT NOT NULL;

ALTER TABLE audit_log
  DROP FOREIGN KEY fk_audit_ticket,
  DROP INDEX idx_audit_ticket,
  DROP COLUMN ticket_id;

DELETE FROM settings WHERE setting_key = 'auto_close_days';
