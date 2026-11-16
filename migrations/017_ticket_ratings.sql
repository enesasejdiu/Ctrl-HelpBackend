-- Satisfaction ratings (routes/tickets.js POST /api/tickets/:id/rating): the requester rates their closed ticket once,
-- 1–5 stars and an optional comment. GET /api/tickets/:id shows it, and GET /api/stats averages them.
--
-- ticket_id is UNIQUE: one rating per ticket, also when two requests race (the second gets 409 ALREADY_RATED).
-- Deleting a ticket deletes its rating (ON DELETE CASCADE).
-- rated_by: the requester who rated it.
-- agent_id: who the ticket was assigned to when it was rated, so an agent's average doesn't change if the ticket is
--   reassigned later. NULL when it was unassigned; deleting that user keeps the rating (SET NULL).
-- stars: 1 to 5, also checked by the database (MySQL 8.0.16+ and MariaDB enforce CHECK).
-- Plain CREATE TABLE: runs the same on MySQL 8/9 (ONLY_FULL_GROUP_BY) and MariaDB.
-- Undone by migrations/down/017_ticket_ratings.sql.
CREATE TABLE ticket_ratings (
  id INT AUTO_INCREMENT PRIMARY KEY,
  ticket_id INT NOT NULL,
  rated_by INT NOT NULL,
  agent_id INT NULL,
  stars TINYINT UNSIGNED NOT NULL,
  comment VARCHAR(500) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_ticket_ratings_ticket (ticket_id),
  INDEX idx_ticket_ratings_agent (agent_id),
  CONSTRAINT chk_ticket_ratings_stars CHECK (stars BETWEEN 1 AND 5),
  CONSTRAINT fk_ticket_ratings_ticket FOREIGN KEY (ticket_id) REFERENCES tickets (id) ON DELETE CASCADE,
  CONSTRAINT fk_ticket_ratings_rater FOREIGN KEY (rated_by) REFERENCES users (id),
  CONSTRAINT fk_ticket_ratings_agent FOREIGN KEY (agent_id) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
