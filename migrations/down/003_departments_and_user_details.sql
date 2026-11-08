-- Undoes migrations/003_departments_and_user_details.sql. Run with npm run db:rollback, which backs up first.
-- DELETES DATA: every department, and each user's department_id, job_title and last_login_at.
-- The old free-text users.department column was never touched, so it still holds what it held before.

-- Foreign key, then its index, then the columns, then the table the key pointed at
ALTER TABLE users DROP FOREIGN KEY fk_users_department;
ALTER TABLE users DROP INDEX idx_users_department;
ALTER TABLE users
  DROP COLUMN department_id,
  DROP COLUMN job_title,
  DROP COLUMN last_login_at;

DROP TABLE departments;
