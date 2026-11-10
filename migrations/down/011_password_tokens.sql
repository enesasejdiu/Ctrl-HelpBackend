-- Undoes migrations/011_password_tokens.sql. Run with npm run db:rollback, which backs up first.
-- Unused reset links are deleted (the older code only knows setup links, and would treat them as one). A user whose
-- reset link is lost this way can be reset again.
DELETE FROM password_tokens WHERE purpose = 'reset';

ALTER TABLE password_tokens
  DROP COLUMN purpose;

RENAME TABLE password_tokens TO password_setup_tokens;
