-- Admin settings (src/routes/settings.js, src/settings.js): categories and priorities managed in the app, and the
-- company name. Categories and priorities were already tables that tickets point at (001: tickets.category_id and
-- priority_id, NOT NULL foreign keys that refuse deleting a row in use), so no ticket data is converted here; the
-- check at the end confirms that every ticket still has its category and priority.
--
-- categories: sort_order (the order lists show them in), is_active (an archived category can't be chosen for new
--   tickets; tickets that have it keep it), timestamps. Names stay unique; the table's collation (utf8mb4_unicode_ci)
--   already makes that case-insensitive.
-- priorities: level is the rank (1 = least urgent) and becomes unique; it keeps its name because the queries use it
--   and RANK is a reserved word in MySQL 8 (the API calls it "rank"). is_default marks the priority a new ticket gets
--   when none is chosen: default_key is 1 only on that row and NULL everywhere else, and its UNIQUE index lets at most
--   one row be the default (the API keeps exactly one). is_active and timestamps as for categories.
-- settings: one row per setting; company_name starts as "TicketFlow", the name the app has always shown.
--
-- A database without categories or priorities (a fresh install: db:migrate alone used to leave them empty) gets the
-- standard ones (the same list as scripts/reference-data.js), so tickets can be created without db:seed. A database
-- that already has some keeps exactly what it has.
-- Plain ALTER/CREATE TABLE and INSERT ... SELECT: runs the same on MySQL 8/9 and MariaDB.
-- Undone by migrations/down/015_settings.sql.
ALTER TABLE categories
  ADD COLUMN sort_order INT NOT NULL DEFAULT 0,
  ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP;

ALTER TABLE priorities
  ADD COLUMN is_default BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN default_key TINYINT AS (IF(is_default, 1, NULL)) STORED,
  ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  ADD UNIQUE INDEX uq_priorities_level (level),
  ADD UNIQUE INDEX uq_priorities_default (default_key);

-- The standard lists, only into tables that are still empty
INSERT INTO categories (name, description, sort_order)
SELECT name, description, sort_order FROM (
  SELECT 'Hardware' AS name, 'Laptops, desktops, monitors, printers and other devices' AS description, 1 AS sort_order
  UNION ALL SELECT 'Software', 'Installing, updating or fixing applications', 2
  UNION ALL SELECT 'Network', 'Wi-Fi, cabling, internet and network outages', 3
  UNION ALL SELECT 'Access', 'Accounts, passwords, VPN and permissions', 4
  UNION ALL SELECT 'Email', 'Mailboxes, Outlook, calendars and suspicious emails', 5
  UNION ALL SELECT 'Other', 'Anything that does not fit another category', 6
) standard
WHERE NOT EXISTS (SELECT 1 FROM categories);

INSERT INTO priorities (name, level, target_hours)
SELECT name, level, target_hours FROM (
  SELECT 'Low' AS name, 1 AS level, 120 AS target_hours
  UNION ALL SELECT 'Medium', 2, 72
  UNION ALL SELECT 'High', 3, 24
  UNION ALL SELECT 'Critical', 4, 4
) standard
WHERE NOT EXISTS (SELECT 1 FROM priorities);

-- Existing categories keep the order lists showed them in (by name)
UPDATE categories c
JOIN (SELECT id, ROW_NUMBER() OVER (ORDER BY name, id) AS position FROM categories) ordered ON ordered.id = c.id
SET c.sort_order = ordered.position, c.updated_at = c.updated_at
WHERE c.sort_order = 0;

-- The default: "Medium" if there is one (the app has always suggested it), otherwise the second rank, otherwise the
-- first. Picked into a variable first: MySQL refuses an UPDATE whose subquery reads the same table.
SET @default_priority = COALESCE(
  (SELECT id FROM priorities WHERE name = 'Medium' LIMIT 1),
  (SELECT id FROM priorities ORDER BY level LIMIT 1 OFFSET 1),
  (SELECT id FROM priorities ORDER BY level LIMIT 1)
);
UPDATE priorities SET is_default = TRUE, updated_at = updated_at WHERE id = @default_priority;

CREATE TABLE settings (
  setting_key VARCHAR(50) NOT NULL PRIMARY KEY,
  setting_value VARCHAR(255) NOT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO settings (setting_key, setting_value) VALUES ('company_name', 'TicketFlow');

-- The summary db:migrate prints: every ticket still has a category and a priority (both 0 when all is well)
SELECT
  '015' AS summary,
  (SELECT COUNT(*) FROM tickets t LEFT JOIN categories c ON c.id = t.category_id WHERE c.id IS NULL)
    AS tickets_without_category,
  (SELECT COUNT(*) FROM tickets t LEFT JOIN priorities p ON p.id = t.priority_id WHERE p.id IS NULL)
    AS tickets_without_priority,
  (SELECT COUNT(*) FROM priorities WHERE is_default) AS default_priorities;
