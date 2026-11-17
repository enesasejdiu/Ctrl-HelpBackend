-- Full-text search over tickets, for GET /api/search/suggestions (src/search.js, README "Similar tickets and
-- articles"): while someone types a new ticket's title, open tickets with similar words are suggested.
-- One FULLTEXT index over the two columns the search reads, title and description (MATCH must name exactly the
-- columns of one FULLTEXT index).
-- Plain ALTER TABLE ... ADD FULLTEXT INDEX: runs the same on MySQL 8/9 and MariaDB. Changes no data. The first
-- FULLTEXT index on a table makes InnoDB rebuild it (adding its hidden FTS_DOC_ID column); writes to tickets wait
-- while that runs, which is quick at this app's size but worth knowing on a very large table.
-- Undone by migrations/down/021_ticket_search_index.sql.
ALTER TABLE tickets ADD FULLTEXT INDEX ft_tickets_search (title, description);
