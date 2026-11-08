-- Undoes migrations/002_add_hr_role_and_departments.sql. Run with npm run db:rollback, which backs up first.
-- DELETES DATA: every department, and each user's department_id, job_title, must_change_password and last_login_at.
-- The old free-text users.department column was never touched, so it still holds what it held before.

-- Without strict mode (the XAMPP default), shrinking the enum would silently blank the role of every hr user.
-- Strict mode makes it fail with "Data truncated for column 'role'" instead. This only affects this connection.
SET SESSION sql_mode = CONCAT_WS(',', NULLIF(@@SESSION.sql_mode, ''), 'STRICT_ALL_TABLES');

-- Removing hr can't be done cleanly while someone has it, because their role would be lost. So this comes first:
-- if any user still has the hr role, the rollback stops here with nothing changed. Give those users another role
-- (UPDATE users SET role = 'employee' WHERE role = 'hr') and run it again.
ALTER TABLE users
  MODIFY COLUMN role ENUM('employee', 'agent', 'admin') NOT NULL DEFAULT 'employee';

-- Foreign key, then its index, then the columns, then the table the key pointed at
ALTER TABLE users DROP FOREIGN KEY fk_users_department;
ALTER TABLE users DROP INDEX idx_users_department;
ALTER TABLE users
  DROP COLUMN department_id,
  DROP COLUMN job_title,
  DROP COLUMN must_change_password,
  DROP COLUMN last_login_at;

DROP TABLE departments;
