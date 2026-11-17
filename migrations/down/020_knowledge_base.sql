-- Undoes migrations/020_knowledge_base.sql. Run with npm run db:rollback, which backs up first.
-- DELETES DATA: every knowledge-base article and category. The audit log's kb.* entries stay.
DROP TABLE kb_articles;
DROP TABLE kb_categories;
