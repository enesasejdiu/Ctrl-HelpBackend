-- Undoes migrations/009_audit_log.sql. Run with npm run db:rollback, which backs up first.
-- The whole audit history is lost; export it first (GET /api/audit) if it may still be needed.
DROP TABLE audit_log;
