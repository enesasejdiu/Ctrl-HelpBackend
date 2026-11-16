-- Undoes migrations/018_attachment_hash_and_comment.sql. Run with npm run db:rollback, which backs up first.
-- DELETES DATA: the files' hashes and which comment each file belonged to (the files stay, on their tickets).
-- Dropping the column also drops the index MySQL/MariaDB made for the foreign key.
ALTER TABLE attachments DROP FOREIGN KEY fk_attachments_comment;
ALTER TABLE attachments DROP COLUMN comment_id, DROP COLUMN sha256;
