-- Adds the HR role and the "must change password" flag for accounts created by an admin or HR.
-- 'hr' goes at the END of the ENUM: MySQL can add a value there without rebuilding the table or touching
-- existing rows. (Inserting it in the middle would renumber the values and rewrite the whole table.)
-- must_change_password is set for accounts created with a temporary password. Existing users get FALSE.
ALTER TABLE users
  MODIFY role ENUM('employee', 'agent', 'admin', 'hr') NOT NULL DEFAULT 'employee',
  ADD COLUMN must_change_password BOOLEAN NOT NULL DEFAULT FALSE;
