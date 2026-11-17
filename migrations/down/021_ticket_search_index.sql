-- Undoes migrations/021_ticket_search_index.sql. Run with npm run db:rollback, which backs up first.
-- Removes only the index; no data is lost. Search suggestions then fail (MATCH needs the index), so roll back the code
-- too.
ALTER TABLE tickets DROP INDEX ft_tickets_search;
