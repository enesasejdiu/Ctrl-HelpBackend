-- Turns the free-text users.department values into rows in departments and links each user through department_id.
-- Runs after 003 (which created departments and users.department_id). Undone by
-- migrations/down/005_link_users_to_departments.sql. Check the data first with: npm run db:department-report; afterwards: npm run db:verify-departments
--
-- How a value becomes a department:
--   * trimmed, runs of whitespace collapsed to one space; compared without case or accents (the table's collation,
--     utf8mb4_unicode_ci, so "Sales", " sales " and "SALES" are one department, and so are "Café" and "Cafe")
--   * NULL, empty or only whitespace: no department
--   * the name is the most common spelling in the group (after trimming); on a tie, the first by character code
--   * a department that already exists with that name (any case) is reused, not duplicated
--   * near-duplicates ("Slaes", "HR") are only merged through the mapping below, never guessed
--   * users who already have a department_id are left alone
-- Running it again changes nothing: linked users are skipped and existing departments are reused.
--
-- TODO: users.department is kept for now and nothing in the app reads or writes it any more. A later migration drops
-- it, together with the department_migration_005 table below (only needed for the rollback).

-- Which rows this migration created or changed, so the rollback undoes exactly those. Created first, outside the
-- transaction, because CREATE TABLE ends any open transaction in MySQL/MariaDB.
CREATE TABLE IF NOT EXISTS department_migration_005 (
  kind ENUM('department', 'user') NOT NULL,
  row_id INT NOT NULL,
  department_id INT NOT NULL, -- for a user: the department this migration gave them
  PRIMARY KEY (kind, row_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

START TRANSACTION;

-- Explicit merges for near-duplicates: old value (any case, spaces don't matter) → department name.
-- Fill in from the report, one row per value, e.g. ('Slaes', 'Sales'), ('HR', 'Human Resources'). None are needed for
-- the data this was written for.
CREATE TEMPORARY TABLE IF NOT EXISTS department_mapping_005 (
  from_name VARCHAR(100) NOT NULL PRIMARY KEY,
  to_name VARCHAR(100) NOT NULL
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
-- INSERT IGNORE INTO department_mapping_005 (from_name, to_name) VALUES ('Slaes', 'Sales'), ('HR', 'Human Resources');

-- Users to link, with their cleaned value (after the mapping)
CREATE TEMPORARY TABLE department_users_005 (
  user_id INT NOT NULL PRIMARY KEY,
  clean_name VARCHAR(100) NOT NULL
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
INSERT INTO department_users_005 (user_id, clean_name)
  SELECT id, TRIM(REGEXP_REPLACE(department, '[[:space:]]+', ' '))
  FROM users
  WHERE department_id IS NULL AND TRIM(REGEXP_REPLACE(COALESCE(department, ''), '[[:space:]]+', ' ')) <> '';
UPDATE department_users_005 u
  JOIN department_mapping_005 m ON m.from_name = u.clean_name
  SET u.clean_name = TRIM(REGEXP_REPLACE(m.to_name, '[[:space:]]+', ' '));

-- One name per group: the most used spelling, ties broken by character code. PARTITION BY compares with the
-- collation, so spellings that differ only in case or accents land in the same group.
CREATE TEMPORARY TABLE department_names_005 (
  name VARCHAR(100) NOT NULL
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
INSERT INTO department_names_005 (name)
  SELECT clean_name FROM (
    SELECT clean_name, ROW_NUMBER() OVER (PARTITION BY clean_name ORDER BY uses DESC, BINARY clean_name) AS pick
    FROM (SELECT clean_name, COUNT(*) AS uses FROM department_users_005 GROUP BY BINARY clean_name) AS spellings
  ) AS ranked
  WHERE pick = 1;

-- 1. Departments that don't exist yet (with any case or accents)
CREATE TEMPORARY TABLE department_before_005 (id INT NOT NULL PRIMARY KEY);
INSERT INTO department_before_005 (id) SELECT id FROM departments;
INSERT INTO departments (name)
  SELECT n.name FROM department_names_005 n
  WHERE NOT EXISTS (SELECT 1 FROM departments d WHERE d.name = n.name);
INSERT IGNORE INTO department_migration_005 (kind, row_id, department_id)
  SELECT 'department', d.id, d.id FROM departments d
  WHERE d.id NOT IN (SELECT id FROM department_before_005);

-- 2. Link the users. Recorded first, with the department each one gets, so the rollback can tell them apart from
-- later changes.
INSERT IGNORE INTO department_migration_005 (kind, row_id, department_id)
  SELECT 'user', u.user_id, d.id
  FROM department_users_005 u JOIN departments d ON d.name = u.clean_name;
UPDATE users
  JOIN department_users_005 u ON u.user_id = users.id
  JOIN departments d ON d.name = u.clean_name
  SET users.department_id = d.id
  WHERE users.department_id IS NULL;

-- The summary db:migrate prints. Counted into variables first, because a query can't use a temporary table twice.
-- Every name is either a new department or an existing one, so reused = names - created.
SET @created_005 = (SELECT COUNT(*) FROM departments WHERE id NOT IN (SELECT id FROM department_before_005));
SET @reused_005 = (SELECT COUNT(*) FROM department_names_005) - @created_005;
SET @linked_005 = (SELECT COUNT(*) FROM department_users_005);
SELECT
  '005' AS summary,
  @created_005 AS departments_created,
  @reused_005 AS departments_reused,
  @linked_005 AS users_linked,
  (SELECT COUNT(*) FROM users WHERE department_id IS NULL) AS users_without_department;

DROP TEMPORARY TABLE department_mapping_005, department_users_005, department_names_005, department_before_005;

COMMIT;
