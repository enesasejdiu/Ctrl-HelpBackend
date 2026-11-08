-- Adds a departments table and three columns on users: department (as a link), job title, last login.
-- Schema only: nothing in the app reads or writes them yet. Every new column is nullable, so this runs on a table
-- that already has users. Undone by migrations/down/003_departments_and_user_details.sql (npm run db:rollback).

-- Departments people belong to (e.g. IT, Finance, Sales)
CREATE TABLE departments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL UNIQUE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The old free-text users.department column stays for now; department_id is left empty and nothing copies into it.
-- If a department is deleted, its users simply have no department rather than blocking the delete.
ALTER TABLE users
  ADD COLUMN department_id INT NULL AFTER department,
  ADD COLUMN job_title VARCHAR(255) NULL AFTER department_id,
  ADD COLUMN last_login_at TIMESTAMP NULL AFTER is_active,
  ADD INDEX idx_users_department (department_id),
  ADD CONSTRAINT fk_users_department FOREIGN KEY (department_id) REFERENCES departments (id) ON DELETE SET NULL;
