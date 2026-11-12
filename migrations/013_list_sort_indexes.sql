-- Indexes for sorting the paged lists (GET /api/tickets and GET /api/users with ?sort=, src/pagination.js), so a page
-- sorted by one of these columns is read in index order instead of sorting the whole table first. InnoDB adds the
-- primary key (id) to every secondary index, which is the tie-breaker every sort ends with.
-- Not indexed: tickets by priority (sorted by priorities.level, a joined table) and by status (already indexed by
-- 001's idx_tickets_status); users by email (already unique), role and department (a few distinct values, and the
-- users table stays small).
-- Plain ALTER TABLE ... ADD INDEX: runs the same on MySQL 8/9 and MariaDB. Changes no data.
-- Undone by migrations/down/013_list_sort_indexes.sql.
ALTER TABLE tickets
  ADD INDEX idx_tickets_created (created_at),
  ADD INDEX idx_tickets_updated (updated_at),
  ADD INDEX idx_tickets_title (title);

ALTER TABLE users
  ADD INDEX idx_users_created (created_at),
  ADD INDEX idx_users_name (name);
