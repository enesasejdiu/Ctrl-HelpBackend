-- Undoes migrations/012_attachments.sql. Run with npm run db:rollback, which backs up first.
-- DELETES DATA: every attachment row. The files in UPLOAD_DIR are left on disk (delete the folder by hand if wanted).
DROP TABLE attachments;
