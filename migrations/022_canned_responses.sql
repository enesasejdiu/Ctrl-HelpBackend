-- Canned responses (src/routes/cannedResponses.js, README "Canned responses"): prepared replies staff insert into
-- ticket comments. owner_id NULL = shared with all staff (admins manage them); set = personal (only the owner sees and
-- changes it).
--   title        1-100 characters; unique within its scope, ignoring case (utf8mb4_unicode_ci): among the shared
--                ones, and per owner. A UNIQUE on (owner_id, title) alone wouldn't stop two shared titles (NULLs are
--                never equal), so the unique key is on scope_key: 0 for shared, the owner's id for personal ones
--                (ids start at 1). Generated STORED column + UNIQUE: runs on MySQL 8/9 and MariaDB (as in 015).
--   body         1-5,000 characters of plain text; {{placeholders}} are filled in by the frontend
--   usage_count / last_used_at   counted when a response is inserted (POST /:id/used), for "most used first"
-- owner_id is a plain foreign key (no ON DELETE action, like tickets.requester_id): MySQL refuses CASCADE / SET NULL
-- on a column a STORED generated column (scope_key) is built from. Accounts are deactivated, never deleted, so it
-- never matters in practice. created_by / updated_by become NULL if that account is ever deleted.
-- Undone by migrations/down/022_canned_responses.sql.
CREATE TABLE IF NOT EXISTS canned_responses (
  id INT AUTO_INCREMENT PRIMARY KEY,
  title VARCHAR(100) NOT NULL,
  body TEXT NOT NULL,
  owner_id INT NULL,
  scope_key INT AS (IFNULL(owner_id, 0)) STORED,
  created_by INT NULL,
  updated_by INT NULL,
  usage_count INT UNSIGNED NOT NULL DEFAULT 0,
  last_used_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE INDEX uq_canned_responses_scope_title (scope_key, title),
  INDEX idx_canned_responses_owner_title (owner_id, title),
  CONSTRAINT fk_canned_responses_owner FOREIGN KEY (owner_id) REFERENCES users (id),
  CONSTRAINT fk_canned_responses_created_by FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_canned_responses_updated_by FOREIGN KEY (updated_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
