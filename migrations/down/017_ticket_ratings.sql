-- Undoes migrations/017_ticket_ratings.sql. Run with npm run db:rollback, which backs up first.
-- DELETES DATA: every satisfaction rating.
DROP TABLE ticket_ratings;
