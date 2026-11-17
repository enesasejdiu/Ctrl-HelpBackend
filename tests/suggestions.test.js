// GET /api/search/suggestions (routes/search.js, src/search.js, migration 021): open tickets the user may see and
// published help articles similar to a new ticket's title. Relevance order, the minimum relevance, open tickets only,
// the visibility rule (employees and HR: their own; staff: all), published articles only, the fields, and q's length
// rules. The 429 is in suggestions-rate-limit.test.js (the limit is off in the rest of the suite).
const pool = require('../src/db')
const { api, resetData, createUser, loginAs, auth } = require('./helpers')
const { MIN_RELEVANCE, OPEN_STATUSES } = require('../src/search')

let as
let users

beforeAll(async () => {
  await resetData()
  users = {
    admin: await createUser({ role: 'admin', name: 'Ada Admin' }),
    agent: await createUser({ role: 'agent', name: 'Arben Agent' }),
    employee: await createUser({ role: 'employee', name: 'Liridon Employee' }),
    other: await createUser({ role: 'employee', name: 'Besa Other' }),
    hr: await createUser({ role: 'hr', name: 'Teuta HR' }),
  }
  const sessions = {}
  for (const [key, user] of Object.entries(users)) sessions[key] = await loginAs(user)
  as = (who) => ({
    get: (url) => api.get(url).set(auth(sessions[who])),
    post: (url, body) => api.post(url).set(auth(sessions[who])).send(body),
    patch: (url, body) => api.patch(url).set(auth(sessions[who])).send(body),
  })

  // Tickets: what each one is called, who raised it, and whether it is finished
  const ticket = async (who, title, description) => {
    const res = await as(who).post('/api/tickets', { title, description, category_id: 1 })
    expect(res.status).toBe(201)
    return res.body.id
  }
  ids.floor2 = await ticket(
    'employee',
    'Printer on floor 2 not printing',
    'The printer says paper jam, nothing is stuck.',
  )
  ids.toner = await ticket('employee', 'Toner warning', 'The second floor printer shows a toner warning.')
  ids.vpn = await ticket('employee', 'VPN disconnects every hour', 'The VPN client drops the connection.')
  ids.finance = await ticket('other', 'Printer not printing in finance', 'The finance printer queue is stuck.')
  ids.hrOwn = await ticket('hr', 'Badge reader at the entrance', 'My badge reader card is refused at the door.')
  ids.resolved = await ticket('employee', 'Printer driver missing', 'Printer driver missing after reinstall.')
  // Everyday tickets, like a real table has: most of them say "computer" and "not", so those words are too common to
  // count on their own (as in real data, where nearly every ticket says something "does not work")
  for (const [title, description] of [
    ['Slow computer', 'The computer does not start quickly, it takes ten minutes.'],
    ['Computer fan noise', 'Loud fan in my computer, it does not stop.'],
    ['Second screen not detected', 'The computer does not see the second screen.'],
    ['Keyboard keys stick', 'Keys stick on my computer keyboard, typing does not work.'],
    ['Mouse stops working', 'The wireless mouse on my computer is not moving.'],
    ['Teams camera black', 'Teams does not show my camera on the computer.'],
    ['Sound not working', 'No sound from the computer speakers.'],
    ['Wi-Fi drops', 'The computer does not stay on the Wi-Fi.'],
  ]) {
    await ticket('employee', title, description)
  }
  const resolved = await as('agent').patch(`/api/tickets/${ids.resolved}/status`, {
    status: 'resolved',
    resolution: 'Driver installed again.',
  })
  expect(resolved.status).toBe(200)

  // Articles: published, and one draft that must never show up
  const category = await as('agent').post('/api/kb/categories', { name: 'Printing' })
  expect(category.status).toBe(201)
  const article = async (fields) => {
    const res = await as('agent').post('/api/kb/articles', { category_id: category.body.id, ...fields })
    expect(res.status).toBe(201)
    return res.body
  }
  articles.printing = await article({
    title: 'Printer not printing',
    summary: 'Check the print queue, then restart the printer.',
    body: 'Open the print queue and cancel stuck jobs. Turn the printer off and on.',
    status: 'published',
  })
  articles.vpn = await article({
    title: 'Connect to the VPN',
    body: '## Steps\n\nOpen the **VPN** client and sign in with your work account.',
    status: 'published',
  })
  // Other published articles, so the table is the size of a small real knowledge base
  for (const title of [
    'Reset your password',
    'Set up email on your phone',
    'Book a meeting room',
    'Use the shared drive',
    'Request new hardware',
    'Join the office Wi-Fi',
  ]) {
    await article({ title, body: `How to ${title.toLowerCase()}, step by step.`, status: 'published' })
  }
  articles.draft = await article({
    title: 'Printer not printing secret draft',
    body: 'Printer printing printer printing (a draft, never suggested).',
  })
})

const ids = {}
const articles = {}
const suggest = (who, q) => as(who).get(`/api/search/suggestions?q=${encodeURIComponent(q)}`)
const ticketIds = (res) => res.body.tickets.map((t) => t.id)
const articleSlugs = (res) => res.body.articles.map((a) => a.slug)

describe('what comes back', () => {
  test('only the agreed fields: no description, requester or comments', async () => {
    const res = await suggest('employee', 'printer not printing')
    expect(res.status).toBe(200)
    expect(Object.keys(res.body)).toEqual(['tickets', 'articles'])
    for (const ticket of res.body.tickets) {
      expect(Object.keys(ticket).sort()).toEqual(['id', 'number', 'status', 'title', 'updated_at'])
      expect(ticket.number).toBe(ticket.id)
    }
    expect(res.body.tickets[0]).toEqual({
      id: ids.floor2,
      number: ids.floor2,
      title: 'Printer on floor 2 not printing',
      status: 'open',
      updated_at: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
    })
    expect(res.body.articles[0]).toEqual({
      slug: 'printer-not-printing',
      title: 'Printer not printing',
      summary: 'Check the print queue, then restart the printer.',
    })
  })

  test('an article without a summary gets the start of its text, as plain text (no Markdown)', async () => {
    const res = await suggest('employee', 'vpn client')
    expect(res.body.articles).toEqual([
      {
        slug: 'connect-to-the-vpn',
        title: 'Connect to the VPN',
        summary: 'Steps Open the VPN client and sign in with your work account.',
      },
    ])
  })

  test('best match first: more of the words, and rarer ones, rank higher', async () => {
    const res = await suggest('employee', 'printer not printing')
    // floor2 has "printer" twice and the rarer "printing"; toner has "printer" once. "Second screen not detected"
    // shares only the common "not" and stays out
    expect(ticketIds(res)).toEqual([ids.floor2, ids.toner])
  })

  test('at most 5 of each', async () => {
    const res = await suggest('agent', 'computer screen keyboard mouse camera fan slow teams')
    expect(res.body.tickets.length).toBeLessThanOrEqual(5)
  })
})

describe('the minimum relevance', () => {
  test(`unrelated text finds nothing`, async () => {
    const res = await suggest('agent', 'coffee machine in the kitchen')
    expect(res.body).toEqual({ tickets: [], articles: [] })
  })

  test(`a word most tickets share is not enough on its own (relevance under ${MIN_RELEVANCE})`, async () => {
    // "computer" is in 8 of the 14 tickets: a weak match the threshold drops…
    const [[{ weak }]] = await pool.query(
      "SELECT MAX(MATCH(title, description) AGAINST ('computer' IN NATURAL LANGUAGE MODE)) AS weak FROM tickets",
    )
    expect(weak).toBeGreaterThan(0)
    expect(weak).toBeLessThan(MIN_RELEVANCE)
    expect((await suggest('agent', 'computer')).body.tickets).toEqual([])
    // …while a word only one ticket has is enough
    expect(ticketIds(await suggest('agent', 'keyboard'))).toHaveLength(1)
  })

  test('words shorter than 3 letters and stopwords are ignored by the full-text search', async () => {
    expect((await suggest('agent', 'is it on the')).body).toEqual({ tickets: [], articles: [] })
  })
})

describe('open tickets only', () => {
  test('resolved (and closed) tickets are never suggested, even with an exact title', async () => {
    expect(OPEN_STATUSES).toEqual(['open', 'assigned', 'in_progress', 'waiting_for_user', 'reopened'])
    const res = await suggest('agent', 'Printer driver missing')
    expect(ticketIds(res)).not.toContain(ids.resolved)
  })
})

describe('visibility (the same rule as the ticket list, inside the query)', () => {
  test("an employee never gets another employee's ticket, even with its exact title", async () => {
    const res = await suggest('employee', 'Printer not printing in finance')
    expect(ticketIds(res)).not.toContain(ids.finance)
    expect(ticketIds(res)).toContain(ids.floor2)
    // The other employee does get it
    expect(ticketIds(await suggest('other', 'Printer not printing in finance'))).toEqual([ids.finance])
  })

  test('HR is an employee for tickets: only their own', async () => {
    expect(ticketIds(await suggest('hr', 'printer not printing'))).toEqual([])
    expect(ticketIds(await suggest('hr', 'badge reader'))).toEqual([ids.hrOwn])
  })

  test.each(['agent', 'admin'])('%s gets every matching open ticket', async (who) => {
    const res = await suggest(who, 'Printer not printing in finance')
    expect(ticketIds(res)[0]).toBe(ids.finance)
    expect(ticketIds(res)).toEqual(expect.arrayContaining([ids.finance, ids.floor2, ids.toner]))
  })
})

describe('articles', () => {
  test.each(['employee', 'agent', 'admin'])('a draft never appears, not even for %s', async (who) => {
    const res = await suggest(who, 'printer not printing secret draft')
    expect(articleSlugs(res)).toEqual(['printer-not-printing'])
  })
})

describe('q', () => {
  test.each([
    ['missing', '/api/search/suggestions'],
    ['empty', '/api/search/suggestions?q='],
    ['2 characters after trimming', `/api/search/suggestions?q=${encodeURIComponent('  pr  ')}`],
  ])('%s → 200 with empty lists', async (_, url) => {
    const res = await as('employee').get(url)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ tickets: [], articles: [] })
  })

  test('3 characters are searched', async () => {
    expect(ticketIds(await suggest('employee', 'vpn'))).toEqual([ids.vpn])
  })

  test('200 characters are fine; 201 → 422 in the usual error form', async () => {
    expect((await suggest('employee', `printer ${'x'.repeat(192)}`)).status).toBe(200)
    const res = await suggest('employee', 'x'.repeat(201))
    expect(res.status).toBe(422)
    expect(res.body).toEqual({
      message: 'Search for at most 200 characters',
      errors: [{ field: 'q', message: 'Search for at most 200 characters' }],
    })
  })

  test('q given twice → 422', async () => {
    const res = await as('employee').get('/api/search/suggestions?q=printer&q=vpn')
    expect(res.status).toBe(422)
  })

  test('the search text is a parameter, never SQL', async () => {
    const res = await suggest('employee', "printer') OR 1=1 -- ")
    expect(res.status).toBe(200)
    expect(ticketIds(res)).not.toContain(ids.finance)
  })

  test('not logged in → 401', async () => {
    expect((await api.get('/api/search/suggestions?q=printer')).status).toBe(401)
  })
})
