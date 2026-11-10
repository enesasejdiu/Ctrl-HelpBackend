-- One-time password links for both cases: a new account setting its first password ('setup') and an admin/HR reset
-- ('reset'). The table from migration 010 (setup links only) is renamed to password_tokens and gets a purpose; its
-- existing rows are setup links. Still only a SHA-256 hash of each token is stored. src/passwordTokens.js issues them
-- (48 hours, one use, a new one removes the user's other unused ones).
-- The index and foreign-key names from 010 stay as they are (renaming them would mean dropping and re-adding them).
-- Undone by migrations/down/011_password_tokens.sql.
RENAME TABLE password_setup_tokens TO password_tokens;

ALTER TABLE password_tokens
  ADD COLUMN purpose ENUM('setup', 'reset') NOT NULL DEFAULT 'setup' AFTER token_hash;
