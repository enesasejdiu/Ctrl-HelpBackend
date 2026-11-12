-- The daily auto-close job (src/jobs/autoClose.js): tickets resolved for auto_close_days (default 7) are closed.
--
-- ticket_history.changed_by becomes nullable: NULL means "the system" (the job), so its changes are recorded like
--   any other, without a fake user.
-- audit_log gets ticket_id, so the job's ticket_auto_closed entries point at the ticket (NULL for the account events
--   that were there before). Deleting a ticket keeps the entry, with ticket_id NULL.
-- settings gets auto_close_days = 7 (0 switches the job off), unless it is already set.
--
-- resolved_at already exists (001) and is set by every resolve, so tickets keep their real resolve time. As a safety
-- net, a resolved ticket without one (data imported by hand, say) gets the time it was last set to resolved in
-- ticket_history, or, without that, the time this migration ran: never updated_at or created_at, so old tickets aren't
-- all closed by the first run without warning. The summary at the end says how many came from which source.
-- Plain ALTER/UPDATE: runs the same on MySQL 8/9 and MariaDB.
-- Undone by migrations/down/016_auto_close.sql.
ALTER TABLE ticket_history
  MODIFY COLUMN changed_by INT NULL;

ALTER TABLE audit_log
  ADD COLUMN ticket_id INT NULL AFTER target_user_id,
  ADD INDEX idx_audit_ticket (ticket_id),
  ADD CONSTRAINT fk_audit_ticket FOREIGN KEY (ticket_id) REFERENCES tickets (id) ON DELETE SET NULL;

INSERT INTO settings (setting_key, setting_value) VALUES ('auto_close_days', '7')
  ON DUPLICATE KEY UPDATE setting_value = setting_value;

-- Backfill, counted first so the summary can tell the sources apart
CREATE TEMPORARY TABLE backfill_016 AS
  SELECT t.id,
         (SELECT MAX(h.changed_at) FROM ticket_history h
          WHERE h.ticket_id = t.id AND h.field_changed = 'status' AND h.new_value = 'resolved') AS history_time
  FROM tickets t
  WHERE t.status = 'resolved' AND t.resolved_at IS NULL;

SET @from_history = (SELECT COUNT(*) FROM backfill_016 WHERE history_time IS NOT NULL);
SET @from_migration_time = (SELECT COUNT(*) FROM backfill_016 WHERE history_time IS NULL);

UPDATE tickets t
  JOIN backfill_016 b ON b.id = t.id
  SET t.resolved_at = COALESCE(b.history_time, NOW());

DROP TEMPORARY TABLE backfill_016;

-- The summary db:migrate prints
SELECT
  '016' AS summary,
  (SELECT COUNT(*) FROM tickets WHERE status = 'resolved') AS resolved_tickets,
  @from_history AS resolved_at_from_history,
  @from_migration_time AS resolved_at_from_migration_time,
  (SELECT setting_value FROM settings WHERE setting_key = 'auto_close_days') AS auto_close_days;
