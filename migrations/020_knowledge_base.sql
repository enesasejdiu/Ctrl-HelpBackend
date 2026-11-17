-- Knowledge base (src/kb.js, routes/kb.js, README "Knowledge base"): help articles in categories. Everyone signed in
-- reads published articles; staff (agents and admins) write them.
--
-- kb_categories: name 1-60 characters, unique (the utf8mb4_unicode_ci collation makes that case-insensitive: "Email"
--   and "email" can't both exist), slug made from the name for /kb/c/<slug>, sort_order for the list (then by name).
-- kb_articles:
--   slug       unique, a-z 0-9 and "-", made from the title; fixed once the article has been published (published_at
--              set), so links to it never break
--   summary    optional, the excerpt in lists (else the start of the body)
--   body       Markdown as written (MEDIUMTEXT: up to 100,000 characters of UTF-8); rendered and sanitized by the
--              frontend
--   status     draft | published
--   published_at  set the first time it's published and kept after that (also when it's unpublished again)
--   updated_at    DATETIME(3): to the millisecond, because PATCH sends it back to detect that someone else saved
--                 in between (409 ARTICLE_CHANGED)
--   category_id  ON DELETE RESTRICT: a category with articles can't be deleted (the API says 409 CATEGORY_IN_USE first)
--   author_id / updated_by  who wrote it / who saved it last; NULL if that user is ever deleted, the article stays
-- Indexes: the list (status, category, newest first) and FULLTEXT (title, summary, body) for search.
-- Plain CREATE TABLE: runs the same on MySQL 8/9 and MariaDB (InnoDB FULLTEXT since MySQL 5.6 / MariaDB 10.0.5).
-- Undone by migrations/down/020_knowledge_base.sql.
CREATE TABLE kb_categories (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(60) NOT NULL,
  slug VARCHAR(80) NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_kb_categories_name (name),
  UNIQUE KEY uq_kb_categories_slug (slug),
  INDEX idx_kb_categories_order (sort_order, name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE kb_articles (
  id INT AUTO_INCREMENT PRIMARY KEY,
  title VARCHAR(200) NOT NULL,
  slug VARCHAR(220) NOT NULL,
  summary VARCHAR(300) NULL,
  body MEDIUMTEXT NOT NULL,
  category_id INT NOT NULL,
  status ENUM('draft', 'published') NOT NULL DEFAULT 'draft',
  author_id INT NULL,
  updated_by INT NULL,
  published_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_kb_articles_slug (slug),
  INDEX idx_kb_articles_list (status, category_id, published_at),
  INDEX idx_kb_articles_updated (updated_at),
  FULLTEXT KEY ft_kb_articles (title, summary, body),
  CONSTRAINT fk_kb_articles_category FOREIGN KEY (category_id) REFERENCES kb_categories (id) ON DELETE RESTRICT,
  CONSTRAINT fk_kb_articles_author FOREIGN KEY (author_id) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_kb_articles_updated_by FOREIGN KEY (updated_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
