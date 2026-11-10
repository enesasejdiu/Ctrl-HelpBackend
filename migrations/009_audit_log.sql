-- Audit log of security events (src/audit.js): logins (success and failure), lockouts, logouts, password changes and
-- resets, and account changes (created, edited, role, active status). Shown to admins by GET /api/audit.
-- actor_id: who did it (NULL for a failed login with an unknown email). target_user_id: whose account it concerns.
-- Both become NULL if that user is deleted, so the history stays. details: what happened, as JSON, never a password,
-- hash, token or session id. ip: the client's address (IPv6 fits in 45 characters).
-- JSON is a real type on MySQL and an alias of LONGTEXT with a json_valid() check on MariaDB; the API parses it the same
-- way on both. Plain CREATE TABLE: runs the same on MySQL 8/9 (ONLY_FULL_GROUP_BY) and MariaDB.
-- Undone by migrations/down/009_audit_log.sql.
CREATE TABLE audit_log (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  actor_id INT NULL,
  action VARCHAR(50) NOT NULL,
  target_user_id INT NULL,
  details JSON NULL,
  ip VARCHAR(45) NULL,
  -- The page lists newest first and filters by action, by user (as actor or target) and by date
  INDEX idx_audit_created (created_at),
  INDEX idx_audit_action_created (action, created_at),
  INDEX idx_audit_actor (actor_id),
  INDEX idx_audit_target (target_user_id),
  CONSTRAINT fk_audit_actor FOREIGN KEY (actor_id) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_audit_target FOREIGN KEY (target_user_id) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
