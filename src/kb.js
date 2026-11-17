// Knowledge base (migration 020; routes/kb.js; README "Knowledge base"): slugs, excerpts and the shared queries.
// Articles are Markdown, stored exactly as written; the frontend renders and sanitizes them. Nothing here ever turns
// Markdown into HTML.

const ARTICLE_SLUG_MAX = 220
const CATEGORY_SLUG_MAX = 80
// Room for a "-NN" suffix when the slug is already taken
const SUFFIX_ROOM = 6
const EXCERPT_LENGTH = 200
// The frontend's own pages under /kb/ (/kb/new, /kb/manage, /kb/search): no article may take these slugs, or its
// address would open that page instead. A title that makes one gets "-2".
const RESERVED_ARTICLE_SLUGS = ['new', 'manage', 'search']

// Letters that don't fall apart into a base letter + an accent: written out by hand. Albanian ë and ç (and the rest)
// do decompose, so normalize('NFD') turns them into e / c below.
const SPECIAL_LETTERS = { ß: 'ss', æ: 'ae', œ: 'oe', ø: 'o', đ: 'd', ł: 'l', þ: 'th', ı: 'i' }

// "Wi-Fi në zyrë: si të lidhesh?" → "wi-fi-ne-zyre-si-te-lidhesh". Lowercase a-z, 0-9 and single dashes, at most `max`
// characters (cut after a whole word when it's too long), never starting or ending with a dash. Empty when nothing
// usable is left (e.g. "!!!").
function slugify(text, max) {
  const full = String(text ?? '')
    .toLowerCase()
    .replace(/[ßæœøđłþı]/g, (letter) => SPECIAL_LETTERS[letter])
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // the accents NFD split off: ë → e, ç → c
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (full.length <= max) return full
  const cut = full.slice(0, max)
  // Mid-word: go back to the end of the last whole word, if there is one
  const lastDash = cut.lastIndexOf('-')
  return (full[max] !== '-' && lastDash > 0 ? cut.slice(0, lastDash) : cut).replace(/-+$/g, '')
}

// A slug that isn't used yet: `base`, else base-2, base-3, … `taken(slug)` says whether a slug is in use (excluding
// the row being renamed). The database's UNIQUE index has the last word if two requests race.
async function freeSlug(base, max, fallback, taken) {
  const root = slugify(base, max - SUFFIX_ROOM) || fallback
  if (!(await taken(root))) return root
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${root}-${n}`
    if (!(await taken(candidate))) return candidate
  }
  throw new Error(`No free slug for "${root}"`)
}

// The start of an article's text without Markdown syntax, for the excerpt when it has no summary. Rough on purpose:
// it only has to read well, it's escaped like any text by the frontend, and it's never rendered as Markdown.
function plainText(markdown, length = EXCERPT_LENGTH) {
  const text = String(markdown ?? '')
    .replace(/```[\s\S]*?(```|$)/g, ' ') // code blocks
    .replace(/<[^>]*>/g, ' ') // HTML tags (never shown as HTML anyway)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ') // images
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // links: keep the text
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '') // headings, quotes, list markers
    .replace(/^\s*([-*_]\s*){3,}$/gm, ' ') // horizontal rules
    .replace(/^\s*\|?(\s*:?-+:?\s*\|)+\s*$/gm, ' ') // table separator rows
    .replace(/[*_~`|]/g, '') // emphasis, inline code, table pipes
    .replace(/\s+/g, ' ')
    .trim()
  if (text.length <= length) return text
  const cut = text.slice(0, length)
  // End at a word boundary when there's one reasonably close
  const space = cut.lastIndexOf(' ')
  return `${(space > length * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`
}

// The columns of a list item (no body: only its first characters, for the excerpt when there's no summary)
const ARTICLE_LIST_COLUMNS = `
  a.id, a.slug, a.title, a.summary, a.status, a.updated_at, a.published_at,
  IF(a.summary IS NULL OR a.summary = '', LEFT(a.body, 2000), NULL) AS body_start,
  c.id AS category_id, c.name AS category_name, c.slug AS category_slug`

// A whole article, with its category and the names of who wrote it and who saved it last
const ARTICLE_COLUMNS = `
  a.id, a.slug, a.title, a.summary, a.body, a.status, a.published_at, a.created_at, a.updated_at,
  c.id AS category_id, c.name AS category_name, c.slug AS category_slug,
  a.author_id, author.name AS author_name, a.updated_by AS updated_by_id, editor.name AS updated_by_name`

const ARTICLE_FROM = `
  FROM kb_articles a
  JOIN kb_categories c ON c.id = a.category_id
  LEFT JOIN users author ON author.id = a.author_id
  LEFT JOIN users editor ON editor.id = a.updated_by`

const category = (row) => ({ id: row.category_id, name: row.category_name, slug: row.category_slug })

function listItem(row) {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    summary: row.summary || plainText(row.body_start),
    category: category(row),
    status: row.status,
    updated_at: row.updated_at,
    published_at: row.published_at,
  }
}

function fullArticle(row) {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    summary: row.summary,
    body: row.body,
    category: category(row),
    status: row.status,
    published_at: row.published_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    author: row.author_id ? { id: row.author_id, name: row.author_name } : null,
    updated_by: row.updated_by_id ? { id: row.updated_by_id, name: row.updated_by_name } : null,
  }
}

module.exports = {
  RESERVED_ARTICLE_SLUGS,
  ARTICLE_SLUG_MAX,
  CATEGORY_SLUG_MAX,
  EXCERPT_LENGTH,
  slugify,
  freeSlug,
  plainText,
  ARTICLE_LIST_COLUMNS,
  ARTICLE_COLUMNS,
  ARTICLE_FROM,
  listItem,
  fullArticle,
}
