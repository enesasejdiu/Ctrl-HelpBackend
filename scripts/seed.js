// Fills the database with demo data: categories, priorities, departments, 6 users, tickets with history, and comments.
// WIPES ALL TABLES FIRST, so it refuses to run on a database that already has users unless you pass --force.
// Usage: npm run db:seed (empty database), or npm run db:seed -- --force (wipe and reseed; run db:backup first)
//
// Ticket timestamps are relative to "now", so the demo always looks fresh (recent tickets, overdue ones, a
// weekly trend). Each ticket is described as a list of events (assign / status change); the script derives
// the ticket's final status, assignee and timestamps AND its ticket_history from those same events,
// so the history always tells the same story as the ticket.
require('dotenv').config()

const bcrypt = require('bcryptjs')
const pool = require('../src/db')
const { categories, priorities } = require('./reference-data')

const PASSWORD = 'password123'
const HOUR = 60 * 60 * 1000
const now = Date.now()

// Operations has nobody in it, so "delete an empty department" can be tried on the demo data
const departments = ['IT', 'Finance', 'Sales', 'Human Resources', 'Operations']

// key → [name, email, role, department name or null]; tickets below refer to users by key.
// The admin has no department, so the demo also shows a user without one.
const users = {
  admin: ['Admin User', 'admin@ticketflow.local', 'admin', null],
  agent1: ['Arben Krasniqi', 'agent1@ticketflow.local', 'agent', 'IT'],
  agent2: ['Drita Berisha', 'agent2@ticketflow.local', 'agent', 'IT'],
  employee1: ['Liridon Gashi', 'employee1@ticketflow.local', 'employee', 'Finance'],
  employee2: ['Vjosa Hoxha', 'employee2@ticketflow.local', 'employee', 'Sales'],
  hr: ['Teuta Morina', 'hr@ticketflow.local', 'hr', 'Human Resources'],
}

// ago = hours before now the ticket was created; event/comment `at` = hours after the ticket was created.
// Events: { at, by, assign: userKey } or { at, by, status }. Assigning an open/reopened ticket also moves it
// to "assigned", exactly like PATCH /api/tickets/:id/assign does.
const tickets = [
  {
    title: 'Projector in the boardroom not working',
    description: 'The projector shows "No signal" with every laptop. The board meeting starts in 3 hours.',
    requester: 'employee2',
    category: 'Other',
    priority: 'Critical',
    ago: 40 * 24,
    resolution:
      'HDMI switch behind the wall panel had failed. Bypassed it with a direct HDMI cable and ordered a new switch.',
    events: [
      { at: 0.2, by: 'agent2', assign: 'agent2' },
      { at: 0.5, by: 'agent2', status: 'in_progress' },
      { at: 2.5, by: 'agent2', status: 'resolved' },
      { at: 26, by: 'employee2', status: 'closed' },
    ],
  },
  {
    title: 'New colleague needs access to the CRM',
    description: 'Our new sales rep starts on Monday and needs a CRM account with the Sales role.',
    requester: 'employee2',
    category: 'Access',
    priority: 'Low',
    ago: 33 * 24,
    resolution: "CRM account created with the Sales role. Login details sent to the new colleague's manager.",
    events: [
      { at: 5, by: 'admin', assign: 'agent1' },
      { at: 50, by: 'agent1', status: 'in_progress' },
      { at: 52, by: 'agent1', status: 'resolved' },
      { at: 75, by: 'employee2', status: 'closed' },
    ],
  },
  {
    title: 'Excel crashes when opening large reports',
    description: 'Excel freezes and closes whenever I open the monthly finance report (about 80 MB).',
    requester: 'employee1',
    category: 'Software',
    priority: 'Medium',
    ago: 25 * 24,
    resolution:
      'Installed the 64-bit version of Office so Excel can use more memory. The report now opens in about 20 seconds.',
    events: [
      { at: 3, by: 'agent1', assign: 'agent1' },
      { at: 5, by: 'agent1', status: 'in_progress' },
      { at: 28, by: 'agent1', status: 'resolved' },
      { at: 48, by: 'employee1', status: 'closed' },
    ],
  },
  {
    title: 'Suspicious email asking for my password',
    description: 'I got an email "from IT" asking me to confirm my password via a link. I did not click it.',
    requester: 'employee2',
    category: 'Email',
    priority: 'High',
    ago: 11 * 24,
    resolution: 'Confirmed phishing. Blocked the sender domain, removed the email from all mailboxes and warned staff.',
    events: [
      { at: 0.5, by: 'agent2', assign: 'agent2' },
      { at: 1, by: 'agent2', status: 'in_progress' },
      { at: 4, by: 'agent2', status: 'resolved' },
    ],
  },
  {
    title: 'Finance shared mailbox missing in Outlook',
    description: 'The finance@ shared mailbox disappeared from my Outlook after the update yesterday.',
    requester: 'employee1',
    category: 'Email',
    priority: 'High',
    ago: 4 * 24,
    resolution:
      'Mailbox permissions were reset by the migration. Re-added full access; it shows up again after restarting Outlook.',
    events: [
      { at: 1, by: 'admin', assign: 'agent2' },
      { at: 2, by: 'agent2', status: 'in_progress' },
      { at: 6, by: 'agent2', status: 'resolved' },
      { at: 30, by: 'employee1', status: 'closed' },
    ],
  },
  {
    title: 'Monitor keeps flickering',
    description: 'My second monitor flickers every few minutes. It is worse in the afternoon.',
    requester: 'employee1',
    category: 'Hardware',
    priority: 'Low',
    ago: 90,
    resolution: 'Replaced the DisplayPort cable.',
    events: [
      { at: 2, by: 'agent1', assign: 'agent1' },
      { at: 20, by: 'agent1', status: 'in_progress' },
      { at: 30, by: 'agent1', status: 'resolved' },
      { at: 60, by: 'employee1', status: 'reopened' },
    ],
    comments: [
      { at: 60.1, by: 'employee1', content: 'The flickering came back this morning, even with the new cable.' },
      {
        at: 62,
        by: 'agent1',
        internal: true,
        content: 'Probably the monitor itself, not the cable. Ordering a replacement Dell P2422H.',
      },
    ],
  },
  {
    title: 'Printer on 2nd floor jams',
    description: 'The printer next to the kitchen on the 2nd floor jams on almost every print job.',
    requester: 'employee2',
    category: 'Hardware',
    priority: 'Medium',
    ago: 26,
    events: [{ at: 4, by: 'admin', assign: 'agent1' }],
  },
  {
    title: 'Cannot log in to VPN',
    description: 'When I connect to the VPN from home I get "Authentication failed", even with the right password.',
    requester: 'employee1',
    category: 'Access',
    priority: 'Medium',
    ago: 20,
    events: [
      { at: 1, by: 'agent1', assign: 'agent1' },
      { at: 2, by: 'agent1', status: 'in_progress' },
      { at: 3.5, by: 'agent1', status: 'waiting_for_user' },
    ],
    comments: [
      {
        at: 0.5,
        by: 'employee1',
        content: 'It worked fine last week. I changed my password on Monday, if that matters.',
      },
      {
        at: 3,
        by: 'agent1',
        content: 'That is likely it: the VPN only picks up a new password after you sign out of Windows once.',
      },
      {
        at: 3.4,
        by: 'agent1',
        content: 'Could you sign out, sign back in, try the VPN again and let me know if it works?',
      },
    ],
  },
  {
    title: 'Laptop does not turn on',
    description: 'My laptop shows no lights and does not react to the power button, even when plugged in.',
    requester: 'employee1',
    category: 'Hardware',
    priority: 'High',
    ago: 30,
    events: [],
  },
  {
    title: 'Whole office Wi-Fi down',
    description: 'Nobody on the 3rd floor can connect to the Wi-Fi, laptops or phones. Cable still works.',
    requester: 'employee2',
    category: 'Network',
    priority: 'Critical',
    ago: 7,
    events: [
      { at: 0.3, by: 'admin', assign: 'agent2' },
      { at: 0.6, by: 'agent2', status: 'in_progress' },
    ],
    comments: [
      { at: 0.2, by: 'employee2', content: 'We have a client call at 11:00, is there an estimate?' },
      {
        at: 1.5,
        by: 'agent2',
        internal: true,
        content: 'Access point controller rebooted overnight and lost its config. Restoring from the backup.',
      },
    ],
  },
  {
    title: 'Need Excel installed',
    description: 'I need Microsoft Excel on my new laptop for the quarterly sales reports.',
    requester: 'employee2',
    category: 'Software',
    priority: 'Low',
    ago: 3,
    events: [],
  },
]

// Replays a ticket's events, returning its final state and the matching ticket_history rows
function playTicket(def, userIds, userNames) {
  const createdAt = new Date(now - def.ago * HOUR)
  const at = (hours) => new Date(createdAt.getTime() + hours * HOUR)

  const state = { status: 'open', assignedTo: null, resolvedAt: null, closedAt: null, updatedAt: createdAt }
  const history = [{ at: createdAt, by: def.requester, field: 'status', from: null, to: 'open' }]
  const setStatus = (time, by, status) => {
    history.push({ at: time, by, field: 'status', from: state.status, to: status })
    state.status = status
    if (status === 'resolved') state.resolvedAt = time
    if (status === 'closed') state.closedAt = time
    if (status === 'reopened') state.resolvedAt = state.closedAt = null
  }

  for (const event of def.events) {
    const time = at(event.at)
    if (time.getTime() > now) {
      throw new Error(`Event in the future for "${def.title}"`)
    }
    if (event.assign) {
      const oldName = state.assignedTo ? userNames[state.assignedTo] : null
      history.push({ at: time, by: event.by, field: 'assigned_to', from: oldName, to: userNames[event.assign] })
      state.assignedTo = event.assign
      if (['open', 'reopened'].includes(state.status)) setStatus(time, event.by, 'assigned')
    } else {
      setStatus(time, event.by, event.status)
    }
    state.updatedAt = time
  }

  return {
    row: [
      def.title,
      def.description,
      userIds[def.requester],
      state.assignedTo ? userIds[state.assignedTo] : null,
      state.status,
      def.resolution || null,
      createdAt,
      state.updatedAt,
      state.resolvedAt,
      state.closedAt,
    ],
    history,
    createdAt,
  }
}

// force: wipe and reseed even when there are users (npm run db:seed -- --force). Returns false if it refused.
async function seed({ force = process.argv.includes('--force') } = {}) {
  // Safety check: never wipe a database that holds real data by accident
  const [[{ userCount }]] = await pool.query('SELECT COUNT(*) AS userCount FROM users')
  if (userCount > 0 && !force) {
    console.error(
      'Database is not empty. Run `npm run db:backup` first, then `npm run db:seed -- --force` to wipe and reseed.',
    )
    process.exitCode = 1
    return false
  }

  // 1. Wipe everything (TRUNCATE also resets the AUTO_INCREMENT counters). FOREIGN_KEY_CHECKS is per connection, so
  // every statement here runs on the same one.
  const connection = await pool.getConnection()
  try {
    await connection.query('SET FOREIGN_KEY_CHECKS = 0')
    for (const table of [
      'audit_log',
      'sessions',
      // Attachment rows point at tickets; their files in UPLOAD_DIR are left on disk (only the rows are wiped)
      'attachments',
      'ticket_history',
      'comments',
      'tickets',
      'priorities',
      'categories',
      'users',
      'departments',
    ]) {
      await connection.query(`TRUNCATE TABLE ${table}`)
    }
  } finally {
    await connection.query('SET FOREIGN_KEY_CHECKS = 1')
    connection.release()
  }

  // Departments by name: an existing one (any letter case) is reused, so seeding never makes duplicates.
  // LAST_INSERT_ID(id) makes insertId the existing row's id when the name is already there.
  const departmentIds = {}
  for (const name of departments) {
    const [r] = await pool.query(
      'INSERT INTO departments (name) VALUES (?) ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)',
      [name],
    )
    departmentIds[name] = r.insertId
  }

  // 2–3. Lookup tables
  const categoryIds = {}
  for (const [name, description] of categories) {
    const [r] = await pool.query('INSERT INTO categories (name, description) VALUES (?, ?)', [name, description])
    categoryIds[name] = r.insertId
  }
  const priorityIds = {}
  for (const [name, level, targetHours] of priorities) {
    const [r] = await pool.query('INSERT INTO priorities (name, level, target_hours) VALUES (?, ?, ?)', [
      name,
      level,
      targetHours,
    ])
    priorityIds[name] = r.insertId
  }

  // 4. Users, all with the same demo password
  const userIds = {}
  const userNames = {}
  for (const [key, [name, email, role, department]] of Object.entries(users)) {
    const hash = await bcrypt.hash(PASSWORD, 10)
    const [r] = await pool.query(
      'INSERT INTO users (name, email, password_hash, role, department_id) VALUES (?, ?, ?, ?, ?)',
      [name, email, hash, role, department ? departmentIds[department] : null],
    )
    userIds[key] = r.insertId
    userNames[key] = name
  }

  // 5–7. Tickets (oldest first, so ticket ids follow creation order), their history and comments
  const ordered = [...tickets].sort((a, b) => b.ago - a.ago)
  for (const def of ordered) {
    const { row, history, createdAt } = playTicket(def, userIds, userNames)
    const [r] = await pool.query(
      `INSERT INTO tickets (title, description, requester_id, assigned_to, status, resolution,
         created_at, updated_at, resolved_at, closed_at, category_id, priority_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [...row, categoryIds[def.category], priorityIds[def.priority]],
    )
    const ticketId = r.insertId

    for (const h of history) {
      await pool.query(
        `INSERT INTO ticket_history (ticket_id, changed_by, field_changed, old_value, new_value, changed_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [ticketId, userIds[h.by], h.field, h.from, h.to, h.at],
      )
    }
    for (const c of def.comments || []) {
      await pool.query(
        'INSERT INTO comments (ticket_id, user_id, content, is_internal, created_at) VALUES (?, ?, ?, ?, ?)',
        [ticketId, userIds[c.by], c.content, Boolean(c.internal), new Date(createdAt.getTime() + c.at * HOUR)],
      )
    }
  }

  // 8. Summary
  const count = async (table) => (await pool.query(`SELECT COUNT(*) AS n FROM ${table}`))[0][0].n
  console.log('Seed complete:')
  console.log(`  users:          ${await count('users')}`)
  console.log(`  departments:    ${await count('departments')}`)
  console.log(`  categories:     ${await count('categories')}`)
  console.log(`  priorities:     ${await count('priorities')}`)
  console.log(`  tickets:        ${await count('tickets')}`)
  console.log(`  comments:       ${await count('comments')}`)
  console.log(`  history rows:   ${await count('ticket_history')}`)
  console.log('')
  Object.values(users).forEach(([name, email, role]) => console.log(`  ${role.padEnd(9)} ${email.padEnd(27)} ${name}`))
  console.log(`\nAll demo users have password: ${PASSWORD}`)
  return true
}

// Run directly by npm run db:seed; tests/seed.test.js imports seed() instead
if (require.main === module) {
  // Stop with a clear message before connecting if a DB_* setting is missing or malformed (src/config.js)
  require('../src/config').checkConfig('database')
  seed()
    .catch((err) => {
      console.error('Seeding failed:', err.message)
      process.exitCode = 1
    })
    .finally(() => pool.end())
}

module.exports = { seed, departments, users }
