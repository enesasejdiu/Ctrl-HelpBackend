-- Escalation emails (src/jobs/escalation.js, README "Escalation"): every 5 minutes the job emails the active admins a
-- summary of tickets that need attention: urgent tickets nobody has taken, and tickets that became overdue.
--
-- ticket_escalations: one row per ticket and kind, written when the job escalates it, so a ticket is escalated at most
--   once per kind (UNIQUE (ticket_id, kind), also when two API instances race). kind: 'unassigned' or 'overdue'.
--   sent_at: when the job escalated it (whether or not email was set up). Deleting a ticket deletes its rows.
-- settings: escalation_enabled ('true'; 'false' switches the job off) and escalation_unassigned_minutes (120: how long an
--   urgent ticket may stay unassigned), unless they are already set.
-- Plain CREATE TABLE / INSERT: runs the same on MySQL 8/9 and MariaDB.
-- Undone by migrations/down/019_ticket_escalations.sql.
CREATE TABLE ticket_escalations (
  id INT AUTO_INCREMENT PRIMARY KEY,
  ticket_id INT NOT NULL,
  kind VARCHAR(20) NOT NULL,
  sent_at DATETIME NOT NULL,
  UNIQUE KEY uq_ticket_escalations_ticket_kind (ticket_id, kind),
  INDEX idx_ticket_escalations_sent (sent_at),
  CONSTRAINT chk_ticket_escalations_kind CHECK (kind IN ('unassigned', 'overdue')),
  CONSTRAINT fk_ticket_escalations_ticket FOREIGN KEY (ticket_id) REFERENCES tickets (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO settings (setting_key, setting_value) VALUES ('escalation_enabled', 'true')
  ON DUPLICATE KEY UPDATE setting_value = setting_value;
INSERT INTO settings (setting_key, setting_value) VALUES ('escalation_unassigned_minutes', '120')
  ON DUPLICATE KEY UPDATE setting_value = setting_value;
