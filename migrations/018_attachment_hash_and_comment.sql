-- Attachments (migration 012) get two columns (src/attachments.js, routes/attachments.js):
-- sha256: the SHA-256 of the file's content, hex, worked out by the server when it is uploaded. Lets anyone check that
--   the file on disk is still the one that was uploaded. NULL for files uploaded before this migration.
-- comment_id: the comment the file belongs to, when it was added with one (POST /api/tickets/:id/attachments with
--   comment_id; it must be a comment on the same ticket). NULL for a file on the ticket itself. Deleting the comment
--   keeps the file on the ticket (SET NULL).
-- Runs the same on MySQL 8/9 and MariaDB. Undone by migrations/down/018_attachment_hash_and_comment.sql.
ALTER TABLE attachments
  ADD COLUMN sha256 CHAR(64) NULL AFTER size_bytes,
  ADD COLUMN comment_id INT NULL AFTER ticket_id,
  ADD CONSTRAINT fk_attachments_comment FOREIGN KEY (comment_id) REFERENCES comments (id) ON DELETE SET NULL;
