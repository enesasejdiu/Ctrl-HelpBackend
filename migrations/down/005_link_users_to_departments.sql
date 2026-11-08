-- Undoes migrations/005_link_users_to_departments.sql, using the department_migration_005 table it filled in.
-- Run with npm run db:rollback, which backs up first. The users.department text was never changed, so after this the
-- data is as it was before 005.
--   * a user goes back to no department only if they still have the department 005 gave them (a later change stays)
--   * a department 005 created is deleted only if nobody is in it any more; departments that existed before 005 are
--     never touched
-- A created department that someone was put into later is kept (and is no longer tracked once this finishes).

START TRANSACTION;

UPDATE users
  JOIN department_migration_005 t ON t.kind = 'user' AND t.row_id = users.id
  SET users.department_id = NULL
  WHERE users.department_id = t.department_id;

DELETE departments FROM departments
  JOIN department_migration_005 t ON t.kind = 'department' AND t.row_id = departments.id
  WHERE NOT EXISTS (SELECT 1 FROM users WHERE users.department_id = departments.id);

COMMIT;

DROP TABLE department_migration_005;
