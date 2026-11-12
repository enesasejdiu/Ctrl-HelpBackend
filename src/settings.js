// Admin settings read by the rest of the app: categories, priorities (rank = priorities.level, target hours, the
// default), the company name (migration 015) and auto_close_days (migration 016: the auto-close job). routes/settings.js changes them; everything else reads them here.
//
// Cache: these are read on almost every request (dropdowns, new tickets, emails) and change rarely, so each list is
// kept in memory after its first read and dropped by clearCache() after every write. The cache lives in this
// process only: it assumes ONE API server. With several, a change on one would show on the others only after their
// own restart (see the README's "Admin settings").
const pool = require('./db')

const DEFAULT_COMPANY_NAME = 'TicketFlow'
// Days a ticket stays resolved before the daily job closes it; 0 switches the job off
const DEFAULT_AUTO_CLOSE_DAYS = 7
const MAX_AUTO_CLOSE_DAYS = 365

let cache = {}

// Drops everything cached; the next read goes to the database. Called after every write, and by tests that change
// the tables directly.
function clearCache() {
  cache = {}
}

async function cached(key, load) {
  if (!(key in cache)) cache[key] = load()
  try {
    return await cache[key]
  } catch (err) {
    delete cache[key] // a failed read isn't kept
    throw err
  }
}

const formatCategory = (row) => ({
  id: row.id,
  name: row.name,
  description: row.description,
  sort_order: row.sort_order,
  is_active: Boolean(row.is_active),
  created_at: row.created_at,
  updated_at: row.updated_at,
})

// `level` is the column; the API and the rest of the code call it rank. `level` is kept in responses that had it.
const formatPriority = (row) => ({
  id: row.id,
  name: row.name,
  rank: row.level,
  target_hours: row.target_hours,
  is_default: Boolean(row.is_default),
  is_active: Boolean(row.is_active),
  created_at: row.created_at,
  updated_at: row.updated_at,
})

// Every category (archived ones too), in list order: sort_order, then name
function allCategories() {
  return cached('categories', async () => {
    const [rows] = await pool.query(
      `SELECT id, name, description, sort_order, is_active, created_at, updated_at
       FROM categories ORDER BY sort_order, name, id`,
    )
    return rows.map(formatCategory)
  })
}

// Every priority (archived ones too), least urgent first
function allPriorities() {
  return cached('priorities', async () => {
    const [rows] = await pool.query(
      `SELECT id, name, level, target_hours, is_default, is_active, created_at, updated_at
       FROM priorities ORDER BY level, id`,
    )
    return rows.map(formatPriority)
  })
}

// { company_name } and any later settings, as stored (missing rows fall back to the defaults)
function companySettings() {
  return cached('settings', async () => {
    const [rows] = await pool.query('SELECT setting_key, setting_value FROM settings')
    const stored = Object.fromEntries(rows.map((row) => [row.setting_key, row.setting_value]))
    return { company_name: stored.company_name || DEFAULT_COMPANY_NAME }
  })
}

// auto_close_days, read straight from the database (not the cache): the job runs once a day, and another server's
// change must count. A missing or unreadable value means the default.
async function autoCloseDays(db = pool) {
  const [[row]] = await db.query("SELECT setting_value FROM settings WHERE setting_key = 'auto_close_days'")
  const days = Number(row?.setting_value)
  return Number.isInteger(days) && days >= 0 && days <= MAX_AUTO_CLOSE_DAYS ? days : DEFAULT_AUTO_CLOSE_DAYS
}

// What GET /api/settings shows admins: the company name and auto_close_days
async function adminSettings() {
  return { ...(await companySettings()), auto_close_days: await autoCloseDays() }
}

async function companyName() {
  return (await companySettings()).company_name
}

// The category/priority a ticket may be given: { row } when it exists and is active, { problem } otherwise
async function usableCategory(id) {
  const category = (await allCategories()).find((c) => c.id === id)
  if (!category) return { problem: 'missing' }
  return category.is_active ? { row: category } : { problem: 'inactive', row: category }
}

async function usablePriority(id) {
  const priority = (await allPriorities()).find((p) => p.id === id)
  if (!priority) return { problem: 'missing' }
  return priority.is_active ? { row: priority } : { problem: 'inactive', row: priority }
}

async function defaultPriority() {
  return (await allPriorities()).find((p) => p.is_default) ?? null
}

module.exports = {
  DEFAULT_COMPANY_NAME,
  clearCache,
  allCategories,
  allPriorities,
  companySettings,
  adminSettings,
  autoCloseDays,
  DEFAULT_AUTO_CLOSE_DAYS,
  MAX_AUTO_CLOSE_DAYS,
  companyName,
  usableCategory,
  usablePriority,
  defaultPriority,
  formatCategory,
  formatPriority,
}
