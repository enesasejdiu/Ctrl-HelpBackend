-- Undoes migrations/013_forgot_password_tokens.sql. Run with npm run db:rollback, which backs up first.
-- Unused "Forgot password" links are deleted (the older code doesn't know them); the user can simply ask again.
DELETE FROM password_tokens WHERE purpose = 'forgot';

ALTER TABLE password_tokens
  MODIFY COLUMN purpose ENUM('setup', 'reset') NOT NULL DEFAULT 'setup';
