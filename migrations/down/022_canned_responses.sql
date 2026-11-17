-- Undoes migrations/022_canned_responses.sql. Run with npm run db:rollback, which backs up first.
-- DELETES DATA: every canned response, shared and personal. The audit log's canned.* entries stay.
DROP TABLE canned_responses;
