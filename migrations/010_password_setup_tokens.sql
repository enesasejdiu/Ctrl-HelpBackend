-- Set-password links: a new account gets an emailed link ({APP_URL}/set-password?token=...) instead of a temporary
-- password shown to whoever created it. Only a SHA-256 hash of the token is stored, so a copy of this table (a backup,
-- a leaked dump) can't be used to set anyone's password.
-- A token works once (used_at), for 72 hours (expires_at). Setting the password, or sending a new link, removes the
-- user's other unused tokens. Deleting a user deletes their tokens.
-- expires_at and used_at are written by the API (src/passwordSetup.js), so they are DATETIME, not TIMESTAMP.
-- Undone by migrations/down/010_password_setup_tokens.sql.
CREATE TABLE IF NOT EXISTS password_setup_tokens (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  token_hash CHAR(64) NOT NULL,
  expires_at DATETIME NOT NULL,
  used_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_password_setup_tokens_hash (token_hash),
  KEY idx_password_setup_tokens_user (user_id),
  CONSTRAINT fk_password_setup_tokens_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
