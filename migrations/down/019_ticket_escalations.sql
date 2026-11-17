-- Undoes migrations/019_ticket_escalations.sql. Run with npm run db:rollback, which backs up first.
-- The record of which tickets were escalated is lost (a later migrate starts with none, so tickets that are still
-- urgent or overdue are escalated once more). The audit log's ticket_escalated entries stay.
DROP TABLE ticket_escalations;

DELETE FROM settings WHERE setting_key IN ('escalation_enabled', 'escalation_unassigned_minutes');
