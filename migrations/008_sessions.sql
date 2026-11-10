-- Server-side sessions: one row per login. The JWT in the tf_session cookie carries the row's id as "sid", and
-- requireAuth refuses the token unless its row exists, isn't revoked and hasn't expired. So logout (revoked_at) ends
-- the session on the server, not only in the browser, and "log out everywhere" can end all of a user's sessions.
-- id: 32 random bytes, base64url (43 characters, URL-safe). Times use the database clock (NOW()), like the lockout.
-- Rows are deleted 7 days after they expire or are revoked (npm run db:sessions:cleanup, and daily by the server).
-- Plain CREATE TABLE: runs the same on MySQL 8/9 (ONLY_FULL_GROUP_BY) and MariaDB. Undone by
-- migrations/down/008_sessions.sql.
CREATE TABLE sessions (
  id CHAR(43) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  user_id INT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL,
  revoked_at DATETIME NULL,
  last_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ip VARCHAR(45) NULL,
  user_agent VARCHAR(255) NULL,
  INDEX idx_sessions_user (user_id),
  -- Deleting a user deletes their sessions
  CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
