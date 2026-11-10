-- Self-service "Forgot password" links get a purpose of their own, 'forgot': they last 1 hour instead of 48, and
-- completing one also emails a "your password was changed" notice (src/routes/auth.js). 'setup' and 'reset' are
-- unchanged. Only the ENUM grows, so existing rows keep their purpose.
-- Undone by migrations/down/012_forgot_password_tokens.sql.
ALTER TABLE password_tokens
  MODIFY COLUMN purpose ENUM('setup', 'reset', 'forgot') NOT NULL DEFAULT 'setup';
