-- Attachments on tickets (src/attachments.js, routes/attachments.js): files people add to a ticket, such as screenshots,
-- PDFs and logs. The file itself is on disk in UPLOAD_DIR under stored_name, a random id; the name the user gave it is
-- only kept as original_name (shown and used for downloads), never used as a path.
-- ticket_id: deleting a ticket deletes its attachment rows (ON DELETE CASCADE). uploaded_by: who added it.
-- mime_type: the type found from the file's content when it was uploaded, not what the browser claimed.
-- Plain CREATE TABLE: runs the same on MySQL 8/9 (ONLY_FULL_GROUP_BY) and MariaDB.
-- Undone by migrations/down/012_attachments.sql.
CREATE TABLE attachments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  ticket_id INT NOT NULL,
  uploaded_by INT NOT NULL,
  original_name VARCHAR(255) NOT NULL,
  stored_name CHAR(36) NOT NULL,
  mime_type VARCHAR(100) NOT NULL,
  size_bytes INT UNSIGNED NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_attachments_stored_name (stored_name),
  INDEX idx_attachments_ticket (ticket_id, created_at),
  CONSTRAINT fk_attachments_ticket FOREIGN KEY (ticket_id) REFERENCES tickets (id) ON DELETE CASCADE,
  CONSTRAINT fk_attachments_uploader FOREIGN KEY (uploaded_by) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
