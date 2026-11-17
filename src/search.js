// search.js – "Is this the same problem?": open tickets and published help articles that look like a new ticket's
// title (GET /api/search/suggestions, routes/search.js; README "Similar tickets and articles").
//
// Matching is MySQL/MariaDB full-text search in natural-language mode (ft_tickets_search from migration 021,
// ft_kb_articles from 020), best match first. InnoDB scores a row as the sum over the search words it contains of
//   (times the word is in the row) × IDF²,   IDF = log10(rows in the table / rows that contain the word)
// so a rare word counts for a lot and a word that most rows have counts for almost nothing. MIN_RELEVANCE drops rows
// whose only common ground is such a common word: with it, a word must be in fewer than about a third of the rows
// (log10(3)² ≈ 0.23) to make a match on its own, or appear several times.
// The server's full-text settings are left as they are, so: words shorter than innodb_ft_min_token_size (3 by
// default) and InnoDB's stopwords ("the", "is", "for", …) are never matched, and a title made only of those finds
// nothing.
const pool = require('./db')
const { STATUSES } = require('./ticketStatus')
const { plainText } = require('./kb')
const { visibleTicketsSql } = require('./ticketVisibility')

const MIN_RELEVANCE = 0.2
const MAX_RESULTS = 5
// Unfinished tickets: everything but resolved and closed
const OPEN_STATUSES = STATUSES.filter((status) => status !== 'resolved' && status !== 'closed')

const TICKET_MATCH = 'MATCH(t.title, t.description) AGAINST (? IN NATURAL LANGUAGE MODE)'
const ARTICLE_MATCH = 'MATCH(a.title, a.summary, a.body) AGAINST (? IN NATURAL LANGUAGE MODE)'

// Up to 5 open tickets `user` may see (the visibility rule is part of the query: nothing else is ever read), as
// { id, number, title, status, updated_at }. No description, requester or comments.
async function similarTickets(q, user) {
  const visible = visibleTicketsSql(user, 't')
  const [rows] = await pool.query(
    `SELECT t.id, t.title, t.status, t.updated_at, ${TICKET_MATCH} AS relevance
     FROM tickets t
     WHERE ${TICKET_MATCH} AND t.status IN (?)${visible.sql ? ` AND ${visible.sql}` : ''}
     HAVING relevance >= ?
     ORDER BY relevance DESC, t.updated_at DESC, t.id DESC
     LIMIT ?`,
    [q, q, OPEN_STATUSES, ...visible.params, MIN_RELEVANCE, MAX_RESULTS],
  )
  return rows.map((row) => ({
    id: row.id,
    // Tickets are numbered by their id (the app shows "#42")
    number: row.id,
    title: row.title,
    status: row.status,
    updated_at: row.updated_at,
  }))
}

// Up to 5 published articles, as { slug, title, summary }; summary is the article's own, or the start of its text
async function similarArticles(q) {
  const [rows] = await pool.query(
    `SELECT a.slug, a.title, a.summary, LEFT(a.body, 2000) AS body_start, ${ARTICLE_MATCH} AS relevance
     FROM kb_articles a
     WHERE ${ARTICLE_MATCH} AND a.status = 'published'
     HAVING relevance >= ?
     ORDER BY relevance DESC, a.published_at DESC, a.id DESC
     LIMIT ?`,
    [q, q, MIN_RELEVANCE, MAX_RESULTS],
  )
  return rows.map((row) => ({ slug: row.slug, title: row.title, summary: row.summary || plainText(row.body_start) }))
}

module.exports = { similarTickets, similarArticles, MIN_RELEVANCE, MAX_RESULTS, OPEN_STATUSES }
