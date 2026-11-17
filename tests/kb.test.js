// Knowledge base: /api/kb/categories and /api/kb/articles (routes/kb.js, src/kb.js, migration 020).
const pool = require('../src/db')
const { api, resetData, createUser, loginAs, auth, expectError } = require('./helpers')
const { slugify, plainText } = require('../src/kb')

beforeEach(resetData)

async function setup() {
  const users = {
    admin: await createUser({ role: 'admin', name: 'Ada Admin' }),
    agent: await createUser({ role: 'agent', name: 'Arben Agent' }),
    agent2: await createUser({ role: 'agent', name: 'Drita Agent' }),
    employee: await createUser({ role: 'employee', name: 'Liridon Employee' }),
    hr: await createUser({ role: 'hr', name: 'Teuta HR' }),
  }
  const sessions = {}
  for (const [key, user] of Object.entries(users)) sessions[key] = await loginAs(user)
  const as = (who) => ({
    get: (url) => api.get(url).set(auth(sessions[who])),
    post: (url, body) => api.post(url).set(auth(sessions[who])).send(body),
    patch: (url, body) => api.patch(url).set(auth(sessions[who])).send(body),
    delete: (url) => api.delete(url).set(auth(sessions[who])),
  })
  return { users, as }
}

// A category made by an agent; returns it
async function category(as, name = 'Email') {
  const res = await as('agent').post('/api/kb/categories', { name })
  expect(res.status).toBe(201)
  return res.body
}

// An article made by an agent (draft unless status says otherwise); returns it
async function article(as, fields) {
  const res = await as('agent').post('/api/kb/articles', { body: 'Some helpful text.', ...fields })
  expect(res.status).toBe(201)
  return res.body
}

const auditRows = async () =>
  (await pool.query("SELECT action, actor_id, details FROM audit_log WHERE action LIKE 'kb.%' ORDER BY id"))[0].map(
    (row) => ({ ...row, details: typeof row.details === 'string' ? JSON.parse(row.details) : row.details }),
  )

describe('slugs and excerpts (src/kb.js)', () => {
  test.each([
    ['Si të lidhesh me Wi-Fi në zyrë?', 'si-te-lidhesh-me-wi-fi-ne-zyre'],
    ['Çelësi i fjalëkalimit', 'celesi-i-fjalekalimit'],
    ['  VPN: "Authentication failed"!  ', 'vpn-authentication-failed'],
    ['Straße & Œuvre', 'strasse-oeuvre'],
    ['!!!', ''],
  ])('slugify(%j) is %j', (text, slug) => {
    expect(slugify(text, 220)).toBe(slug)
  })

  test('a slug is cut to its maximum without a trailing dash', () => {
    expect(slugify('word '.repeat(100), 22)).toBe('word-word-word-word')
  })

  test('plainText drops the Markdown and keeps the words', () => {
    const md =
      '# Title\n\nSome **bold** and _italic_ text with a [link](https://example.com) and `code`.\n\n```js\nalert(1)\n```\n\n- item one\n> quoted'
    expect(plainText(md)).toBe('Title Some bold and italic text with a link and code. item one quoted')
  })

  test('plainText ends long text at a word, with an ellipsis, within 200 characters', () => {
    const text = plainText('word '.repeat(100))
    expect(text.endsWith('…')).toBe(true)
    expect(text.length).toBeLessThanOrEqual(201)
    expect(text).not.toMatch(/ …$/)
  })
})

describe('categories', () => {
  test('everyone signed in lists them by sort_order then name, with how many published articles each has', async () => {
    const { as } = await setup()
    const network = (await as('agent').post('/api/kb/categories', { name: 'Network', sort_order: 1 })).body
    const email = (await as('agent').post('/api/kb/categories', { name: 'Email', sort_order: 1 })).body
    const start = (await as('agent').post('/api/kb/categories', { name: 'Start here', sort_order: 0 })).body
    await article(as, { title: 'Published one', category_id: email.id, status: 'published' })
    await article(as, { title: 'Draft one here', category_id: email.id })

    for (const who of ['employee', 'hr', 'agent', 'admin']) {
      const res = await as(who).get('/api/kb/categories')
      expect(res.status).toBe(200)
      expect(res.body).toEqual([
        { id: start.id, name: 'Start here', slug: 'start-here', sort_order: 0, published_count: 0 },
        { id: email.id, name: 'Email', slug: 'email', sort_order: 1, published_count: 1 },
        { id: network.id, name: 'Network', slug: 'network', sort_order: 1, published_count: 0 },
      ])
    }
  })

  test('without a session: 401', async () => {
    expect((await api.get('/api/kb/categories')).status).toBe(401)
  })

  test('employees and HR may not create, change or delete categories (403); staff create and change them', async () => {
    const { as } = await setup()
    const email = await category(as)
    for (const who of ['employee', 'hr']) {
      expect((await as(who).post('/api/kb/categories', { name: 'Nope' })).status).toBe(403)
      expect((await as(who).patch(`/api/kb/categories/${email.id}`, { name: 'Nope' })).status).toBe(403)
      expect((await as(who).delete(`/api/kb/categories/${email.id}`)).status).toBe(403)
    }
    const renamed = await as('admin').patch(`/api/kb/categories/${email.id}`, {
      name: 'Email & Calendar',
      sort_order: 5,
    })
    expect(renamed.status).toBe(200)
    expect(renamed.body).toMatchObject({ name: 'Email & Calendar', slug: 'email-calendar', sort_order: 5 })
  })

  test('a name already used, in any case, is 409 CATEGORY_EXISTS (on create and on rename)', async () => {
    const { as } = await setup()
    await category(as, 'Email')
    const network = await category(as, 'Network')
    expectError(await as('agent').post('/api/kb/categories', { name: 'eMaIl' }), 409, 'CATEGORY_EXISTS')
    expectError(await as('agent').patch(`/api/kb/categories/${network.id}`, { name: 'EMAIL' }), 409, 'CATEGORY_EXISTS')
    // Renaming to its own name (another case) is fine
    expect((await as('agent').patch(`/api/kb/categories/${network.id}`, { name: 'NETWORK' })).status).toBe(200)
  })

  test('names that make the same slug get -2', async () => {
    const { as } = await setup()
    expect((await category(as, 'Wi-Fi')).slug).toBe('wi-fi')
    expect((await category(as, 'Wi Fi')).slug).toBe('wi-fi-2')
  })

  test.each([
    ['an empty name', { name: '   ' }, 'name'],
    ['a name over 60 characters', { name: 'x'.repeat(61) }, 'name'],
    ['sort_order that is not a whole number', { name: 'Ok', sort_order: 1.5 }, 'sort_order'],
    ['an unknown field', { name: 'Ok', slug: 'mine' }, 'slug'],
  ])('%s: 422', async (_, body, field) => {
    const { as } = await setup()
    const res = await as('agent').post('/api/kb/categories', body)
    expect(res.status).toBe(422)
    expect(res.body.errors.map((e) => e.field)).toContain(field)
  })

  test('a name of exactly 60 characters is fine', async () => {
    const { as } = await setup()
    expect((await as('agent').post('/api/kb/categories', { name: 'x'.repeat(60) })).status).toBe(201)
  })

  test('only admins delete; a category with articles (even drafts) is 409 CATEGORY_IN_USE; an empty one goes', async () => {
    const { as } = await setup()
    const email = await category(as)
    const empty = await category(as, 'Empty')
    await article(as, { title: 'A draft in it', category_id: email.id })

    expect((await as('agent').delete(`/api/kb/categories/${empty.id}`)).status).toBe(403)
    expectError(await as('admin').delete(`/api/kb/categories/${email.id}`), 409, 'CATEGORY_IN_USE')
    expect((await as('admin').delete(`/api/kb/categories/${empty.id}`)).status).toBe(204)
    expect((await as('admin').delete(`/api/kb/categories/${empty.id}`)).status).toBe(404)
    expect((await as('employee').get('/api/kb/categories')).body.map((c) => c.name)).toEqual(['Email'])
  })

  test('create, rename and delete are in the audit log', async () => {
    const { as, users } = await setup()
    const temp = await category(as, 'Temp')
    await as('admin').patch(`/api/kb/categories/${temp.id}`, { name: 'Temporary' })
    await as('admin').delete(`/api/kb/categories/${temp.id}`)
    expect(await auditRows()).toEqual([
      { action: 'kb.category_created', actor_id: users.agent.id, details: { category_id: temp.id, name: 'Temp' } },
      {
        action: 'kb.category_updated',
        actor_id: users.admin.id,
        details: { category_id: temp.id, name: 'Temporary', fields: ['name'] },
      },
      { action: 'kb.category_deleted', actor_id: users.admin.id, details: { category_id: temp.id, name: 'Temporary' } },
    ])
  })
})

describe('articles: writing (staff)', () => {
  test('an agent creates a draft: 201 with the generated slug, the category and the author', async () => {
    const { as, users } = await setup()
    const email = await category(as)
    const res = await as('agent').post('/api/kb/articles', {
      title: 'Si të lidhesh me Wi-Fi në zyrë',
      summary: '  Connect your laptop to the office network.  ',
      body: '## Steps\n\n1. Open settings',
      category_id: email.id,
    })
    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({
      slug: 'si-te-lidhesh-me-wi-fi-ne-zyre',
      title: 'Si të lidhesh me Wi-Fi në zyrë',
      summary: 'Connect your laptop to the office network.',
      body: '## Steps\n\n1. Open settings',
      status: 'draft',
      published_at: null,
      category: { id: email.id, name: 'Email', slug: 'email' },
      author: { id: users.agent.id, name: 'Arben Agent' },
      updated_by: { id: users.agent.id, name: 'Arben Agent' },
    })
    // To the millisecond, as PATCH must send it back
    expect(res.body.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  })

  test('the same title again gets -2, then -3', async () => {
    const { as } = await setup()
    const email = await category(as)
    const slugs = []
    for (let i = 0; i < 3; i += 1)
      slugs.push((await article(as, { title: 'Reset your password', category_id: email.id })).slug)
    expect(slugs).toEqual(['reset-your-password', 'reset-your-password-2', 'reset-your-password-3'])
  })

  test('titles that would make the slug of a knowledge-base page (new, manage, search) get -2; PATCH refuses them (422)', async () => {
    const { as } = await setup()
    const email = await category(as)
    const slugs = []
    for (const title of ['New!!', 'Manage', 'Search']) {
      // 5+ characters where needed: "New!!" makes "new"
      const res = await as('agent').post('/api/kb/articles', {
        title: title.length >= 5 ? title : `${title}!!`,
        body: 'x',
        category_id: email.id,
      })
      expect(res.status).toBe(201)
      slugs.push(res.body.slug)
    }
    expect(slugs).toEqual(['new-2', 'manage-2', 'search-2'])
    const draft = await article(as, { title: 'Some draft', category_id: email.id })
    for (const slug of ['new', 'manage', 'search']) {
      const res = await as('agent').patch(`/api/kb/articles/${draft.id}`, { updated_at: draft.updated_at, slug })
      expect({ slug, status: res.status, field: res.body.errors?.[0]?.field }).toEqual({
        slug,
        status: 422,
        field: 'slug',
      })
    }
  })

  test('a title without usable characters gets the slug "article"', async () => {
    const { as } = await setup()
    const email = await category(as)
    expect((await article(as, { title: '¿¿¿ ??? !!!', category_id: email.id })).slug).toBe('article')
  })

  test('employees and HR get 403 for create, edit and delete; agents may not delete (403); admins may (204)', async () => {
    const { as } = await setup()
    const email = await category(as)
    const draft = await article(as, { title: 'Agent draft', category_id: email.id })
    for (const who of ['employee', 'hr']) {
      expect(
        (await as(who).post('/api/kb/articles', { title: 'Mine now', body: 'x', category_id: email.id })).status,
      ).toBe(403)
      expect(
        (await as(who).patch(`/api/kb/articles/${draft.id}`, { updated_at: draft.updated_at, title: 'Mine now' }))
          .status,
      ).toBe(403)
      expect((await as(who).delete(`/api/kb/articles/${draft.id}`)).status).toBe(403)
    }
    expect((await as('agent').delete(`/api/kb/articles/${draft.id}`)).status).toBe(403)
    expect((await as('admin').delete(`/api/kb/articles/${draft.id}`)).status).toBe(204)
    expect((await as('admin').get(`/api/kb/articles/${draft.slug}`)).status).toBe(404)
    expect((await as('admin').delete(`/api/kb/articles/${draft.id}`)).status).toBe(404)
  })

  test('another agent and an admin can edit; the article shows who saved it last', async () => {
    const { as, users } = await setup()
    const email = await category(as)
    const draft = await article(as, { title: 'Agent draft', category_id: email.id })
    const res = await as('agent2').patch(`/api/kb/articles/${draft.id}`, {
      updated_at: draft.updated_at,
      body: 'Better.',
    })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      body: 'Better.',
      author: { id: users.agent.id, name: 'Arben Agent' },
      updated_by: { id: users.agent2.id, name: 'Drita Agent' },
    })
    expect(new Date(res.body.updated_at).getTime()).toBeGreaterThan(new Date(draft.updated_at).getTime())
  })

  test('a stale updated_at is 409 ARTICLE_CHANGED and nothing is saved', async () => {
    const { as } = await setup()
    const email = await category(as)
    const draft = await article(as, { title: 'Two editors', category_id: email.id })
    const first = await as('agent').patch(`/api/kb/articles/${draft.id}`, {
      updated_at: draft.updated_at,
      body: 'First save',
    })
    expect(first.status).toBe(200)
    // The second editor still has the version from before the first save
    const second = await as('agent2').patch(`/api/kb/articles/${draft.id}`, {
      updated_at: draft.updated_at,
      body: 'Second save',
    })
    expectError(second, 409, 'ARTICLE_CHANGED')
    expect(second.body.updated_at).toBe(first.body.updated_at)
    expect((await as('agent').get(`/api/kb/articles/${draft.slug}`)).body.body).toBe('First save')
  })

  test('updated_at is required, and must be a date', async () => {
    const { as } = await setup()
    const email = await category(as)
    const draft = await article(as, { title: 'Needs a date', category_id: email.id })
    for (const body of [{ title: 'No date sent' }, { updated_at: 'yesterday', title: 'Bad date' }]) {
      const res = await as('agent').patch(`/api/kb/articles/${draft.id}`, body)
      expect(res.status).toBe(422)
      expect(res.body.errors.map((e) => e.field)).toContain('updated_at')
    }
    // updated_at alone changes nothing: refused too
    const nothing = await as('agent').patch(`/api/kb/articles/${draft.id}`, { updated_at: draft.updated_at })
    expect(nothing.status).toBe(422)
  })

  test('publishing sets published_at once; unpublishing keeps it; publishing again keeps the first date', async () => {
    const { as } = await setup()
    const email = await category(as)
    let current = await article(as, { title: 'Lifecycle', category_id: email.id })
    const patch = async (fields) => {
      const res = await as('agent').patch(`/api/kb/articles/${current.id}`, {
        updated_at: current.updated_at,
        ...fields,
      })
      expect(res.status).toBe(200)
      current = res.body
      return res.body
    }
    const published = await patch({ status: 'published' })
    expect(published.status).toBe('published')
    expect(published.published_at).not.toBeNull()
    const firstDate = published.published_at

    await pool.query('UPDATE kb_articles SET published_at = published_at - INTERVAL 1 DAY WHERE id = ?', [current.id])
    const dated = (await as('agent').get(`/api/kb/articles/${current.slug}`)).body
    current = dated
    const unpublished = await patch({ status: 'draft' })
    expect(unpublished).toMatchObject({ status: 'draft', published_at: dated.published_at })
    const again = await patch({ status: 'published' })
    expect(again.published_at).toBe(dated.published_at)
    expect(again.published_at).not.toBe(firstDate)
  })

  test('the slug can change while it is a draft never published; after the first publish it is fixed (409 SLUG_FIXED)', async () => {
    const { as } = await setup()
    const email = await category(as)
    let current = await article(as, { title: 'Movable page', category_id: email.id })
    const moved = await as('agent').patch(`/api/kb/articles/${current.id}`, {
      updated_at: current.updated_at,
      slug: 'moved-page',
    })
    expect(moved.status).toBe(200)
    expect(moved.body.slug).toBe('moved-page')
    current = moved.body

    current = (
      await as('agent').patch(`/api/kb/articles/${current.id}`, { updated_at: current.updated_at, status: 'published' })
    ).body
    expectError(
      await as('agent').patch(`/api/kb/articles/${current.id}`, {
        updated_at: current.updated_at,
        slug: 'moved-again',
      }),
      409,
      'SLUG_FIXED',
    )
    // Still fixed after unpublishing: links to it may exist
    current = (
      await as('agent').patch(`/api/kb/articles/${current.id}`, { updated_at: current.updated_at, status: 'draft' })
    ).body
    expectError(
      await as('agent').patch(`/api/kb/articles/${current.id}`, {
        updated_at: current.updated_at,
        slug: 'moved-again',
      }),
      409,
      'SLUG_FIXED',
    )
    // Sending the same slug is not a change
    expect(
      (
        await as('agent').patch(`/api/kb/articles/${current.id}`, {
          updated_at: current.updated_at,
          slug: 'moved-page',
          body: 'x',
        })
      ).status,
    ).toBe(200)
  })

  test("another article's slug is 409 SLUG_TAKEN; a badly formed slug is 422", async () => {
    const { as } = await setup()
    const email = await category(as)
    await article(as, { title: 'First article', category_id: email.id })
    const second = await article(as, { title: 'Second article', category_id: email.id })
    const taken = await as('agent').patch(`/api/kb/articles/${second.id}`, {
      updated_at: second.updated_at,
      slug: 'first-article',
    })
    expectError(taken, 409, 'SLUG_TAKEN')
    for (const slug of ['Upper-Case', 'two--dashes', '-leading', 'trailing-', 'spa ce', 'ë', 'x'.repeat(221)]) {
      const res = await as('agent').patch(`/api/kb/articles/${second.id}`, { updated_at: second.updated_at, slug })
      expect({ slug, status: res.status }).toEqual({ slug, status: 422 })
    }
  })

  describe('field limits (422, with the field named)', () => {
    const valid = (categoryId) => ({ title: 'Valid title', body: 'Body', category_id: categoryId })
    test.each([
      ['a title of 4 characters', { title: 'Four' }, 'title'],
      ['a title of 201 characters', { title: 'x'.repeat(201) }, 'title'],
      ['a missing title', { title: undefined }, 'title'],
      ['a summary of 301 characters', { summary: 'x'.repeat(301) }, 'summary'],
      ['an empty body', { body: '' }, 'body'],
      ['a body of only spaces', { body: '   \n  ' }, 'body'],
      ['a body over 100,000 characters', { body: 'x'.repeat(100_001) }, 'body'],
      ['a missing category', { category_id: undefined }, 'category_id'],
      ['a category that does not exist', { category_id: 99999 }, 'category_id'],
      ['an unknown status', { status: 'archived' }, 'status'],
      ['a slug on create (made from the title)', { slug: 'my-own' }, 'slug'],
      ['an unknown field', { author_id: 1 }, 'author_id'],
    ])('%s', async (_, change, field) => {
      const { as } = await setup()
      const email = await category(as)
      const res = await as('agent').post('/api/kb/articles', { ...valid(email.id), ...change })
      expect(res.status).toBe(422)
      expect(res.body.errors.map((e) => e.field)).toContain(field)
      expect(res.body.message).toEqual(expect.any(String))
    })

    test('the limits themselves are fine: title 5 and 200, summary 300, body 100,000 (multi-byte: over 100 KB of JSON)', async () => {
      const { as } = await setup()
      const email = await category(as)
      for (const fields of [
        { title: 'Fives' },
        { title: 'x'.repeat(200), summary: 's'.repeat(300) },
        { body: 'ë'.repeat(100_000) },
      ]) {
        const res = await as('agent').post('/api/kb/articles', { ...valid(email.id), ...fields })
        expect(res.status).toBe(201)
      }
    })

    test('an empty summary is stored as none, and the excerpt comes from the body', async () => {
      const { as } = await setup()
      const email = await category(as)
      const created = await article(as, {
        title: 'No summary here',
        summary: '   ',
        body: '## Heading\n\nThe **first** words of the body.',
        category_id: email.id,
        status: 'published',
      })
      expect(created.summary).toBeNull()
      const list = await as('employee').get('/api/kb/articles')
      expect(list.body.items[0].summary).toBe('Heading The first words of the body.')
    })
  })

  test('create, update, publish, unpublish and delete are in the audit log, without the body', async () => {
    const { as, users } = await setup()
    const email = await category(as)
    const created = await article(as, { title: 'Audited page', body: 'Secret-ish body text', category_id: email.id })
    const updated = (
      await as('agent').patch(`/api/kb/articles/${created.id}`, {
        updated_at: created.updated_at,
        title: 'Audited page 2',
        body: 'New',
      })
    ).body
    const published = (
      await as('agent').patch(`/api/kb/articles/${created.id}`, { updated_at: updated.updated_at, status: 'published' })
    ).body
    await as('agent').patch(`/api/kb/articles/${created.id}`, { updated_at: published.updated_at, status: 'draft' })
    await as('admin').delete(`/api/kb/articles/${created.id}`)

    const rows = (await auditRows()).filter((row) => row.action.startsWith('kb.article'))
    const base = { article_id: created.id, slug: 'audited-page' }
    expect(rows).toEqual([
      { action: 'kb.article_created', actor_id: users.agent.id, details: { ...base, title: 'Audited page' } },
      {
        action: 'kb.article_updated',
        actor_id: users.agent.id,
        details: { ...base, title: 'Audited page 2', fields: ['title', 'body'] },
      },
      { action: 'kb.article_published', actor_id: users.agent.id, details: { ...base, title: 'Audited page 2' } },
      { action: 'kb.article_unpublished', actor_id: users.agent.id, details: { ...base, title: 'Audited page 2' } },
      { action: 'kb.article_deleted', actor_id: users.admin.id, details: { ...base, title: 'Audited page 2' } },
    ])
    expect(JSON.stringify(rows)).not.toContain('Secret-ish')
  })
})

describe('articles: reading', () => {
  test("a draft is 404 for employees and HR, with the same answer as a slug that doesn't exist; staff see it", async () => {
    const { as } = await setup()
    const email = await category(as)
    const draft = await article(as, { title: 'Hidden draft', category_id: email.id })
    const unknown = await as('employee').get('/api/kb/articles/no-such-article')
    expect(unknown.status).toBe(404)
    for (const who of ['employee', 'hr']) {
      const res = await as(who).get(`/api/kb/articles/${draft.slug}`)
      expect({ status: res.status, body: res.body }).toEqual({ status: 404, body: unknown.body })
    }
    for (const who of ['agent', 'admin']) expect((await as(who).get(`/api/kb/articles/${draft.slug}`)).status).toBe(200)
  })

  test('the list follows the pagination contract, has no body, and hides drafts from non-staff even if they ask', async () => {
    const { as } = await setup()
    const email = await category(as)
    await article(as, { title: 'Published A', category_id: email.id, status: 'published' })
    await article(as, { title: 'Draft B here', category_id: email.id })

    for (const query of ['', '?status=draft', '?status=all', '?status=nonsense']) {
      const res = await as('employee').get(`/api/kb/articles${query}`)
      expect({ query, status: res.status }).toEqual({ query, status: 200 })
      expect(Object.keys(res.body).sort()).toEqual(['items', 'page', 'pageSize', 'total'])
      expect(res.body.items.map((a) => a.title)).toEqual(['Published A'])
      expect(res.body.items[0]).not.toHaveProperty('body')
      expect(Object.keys(res.body.items[0]).sort()).toEqual(
        ['category', 'id', 'published_at', 'slug', 'status', 'summary', 'title', 'updated_at'].sort(),
      )
    }
  })

  test('staff see drafts: all by default, or one status; a bad status is 422 for them', async () => {
    const { as } = await setup()
    const email = await category(as)
    await article(as, { title: 'Published A', category_id: email.id, status: 'published' })
    await article(as, { title: 'Draft B here', category_id: email.id })
    const titles = async (query) =>
      (await as('agent').get(`/api/kb/articles${query}`)).body.items.map((a) => a.title).sort()
    expect(await titles('')).toEqual(['Draft B here', 'Published A'])
    expect(await titles('?status=all')).toEqual(['Draft B here', 'Published A'])
    expect(await titles('?status=draft')).toEqual(['Draft B here'])
    expect(await titles('?status=published')).toEqual(['Published A'])
    const bad = await as('agent').get('/api/kb/articles?status=archived')
    expect(bad.status).toBe(422)
    expect(bad.body.errors).toEqual([expect.objectContaining({ field: 'status' })])
  })

  test('newest published first by default; title and updated_at sorts; a category filter by slug; pages', async () => {
    const { as } = await setup()
    const email = await category(as)
    const network = await category(as, 'Network')
    for (const [title, cat, days] of [
      ['Bravo email', email, 3],
      ['Alpha email', email, 1],
      ['Charlie network', network, 2],
    ]) {
      const created = await article(as, { title, category_id: cat.id, status: 'published' })
      await pool.query('UPDATE kb_articles SET published_at = NOW() - INTERVAL ? DAY WHERE id = ?', [days, created.id])
    }
    const titles = async (query) =>
      (await as('employee').get(`/api/kb/articles${query}`)).body.items.map((a) => a.title)
    expect(await titles('')).toEqual(['Alpha email', 'Charlie network', 'Bravo email'])
    expect(await titles('?sort=title')).toEqual(['Alpha email', 'Bravo email', 'Charlie network'])
    expect(await titles('?sort=title&order=desc')).toEqual(['Charlie network', 'Bravo email', 'Alpha email'])
    expect(await titles('?category=email')).toEqual(['Alpha email', 'Bravo email'])
    expect(await titles('?category=no-such-category')).toEqual([])

    const page2 = await as('employee').get('/api/kb/articles?pageSize=2&page=2')
    expect(page2.body).toMatchObject({ total: 3, page: 2, pageSize: 2 })
    expect(page2.body.items.map((a) => a.title)).toEqual(['Bravo email'])
    expect((await as('employee').get('/api/kb/articles?sort=views')).status).toBe(422)
  })

  test('the full article has its category, author, last editor and dates', async () => {
    const { as, users } = await setup()
    const email = await category(as)
    const created = await article(as, {
      title: 'Read me please',
      body: '# Hi',
      category_id: email.id,
      status: 'published',
    })
    const res = await as('employee').get(`/api/kb/articles/${created.slug}`)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      id: created.id,
      title: 'Read me please',
      body: '# Hi',
      status: 'published',
      category: { id: email.id, name: 'Email', slug: 'email' },
      author: { id: users.agent.id, name: 'Arben Agent' },
      updated_by: { id: users.agent.id, name: 'Arben Agent' },
    })
    expect(res.body.published_at).toEqual(expect.any(String))
  })
})

describe('search (?q=)', () => {
  async function searchSetup() {
    const { as } = await setup()
    const hardware = await category(as, 'Hardware')
    const strong = await article(as, {
      title: 'Printer toner replacement',
      summary: 'Replace the printer toner cartridge.',
      body: 'The printer shows a toner warning. Open the printer, take out the old toner, put in the new printer toner.',
      category_id: hardware.id,
      status: 'published',
    })
    const weak = await article(as, {
      title: 'Office equipment overview',
      body: 'Laptops, monitors, docking stations, and one shared printer on each floor.',
      category_id: hardware.id,
      status: 'published',
    })
    const draft = await article(as, {
      title: 'Printer driver draft',
      body: 'Unfinished notes about the printer driver.',
      category_id: hardware.id,
    })
    await article(as, {
      title: 'Monitor flickers',
      body: 'Check the cable.',
      category_id: hardware.id,
      status: 'published',
    })
    return { as, strong, weak, draft }
  }

  test('finds words in title, summary and body, most relevant first', async () => {
    const { as } = await searchSetup()
    const res = await as('employee').get('/api/kb/articles?q=printer')
    expect(res.status).toBe(200)
    expect(res.body.items.map((a) => a.title)).toEqual(['Printer toner replacement', 'Office equipment overview'])
    expect(res.body.total).toBe(2)
  })

  test('non-staff never find drafts; staff do', async () => {
    const { as } = await searchSetup()
    expect((await as('hr').get('/api/kb/articles?q=driver')).body.items).toEqual([])
    expect((await as('agent').get('/api/kb/articles?q=driver')).body.items.map((a) => a.title)).toEqual([
      'Printer driver draft',
    ])
  })

  test('q must be 2 to 200 characters (after trimming); an empty q is no search', async () => {
    const { as } = await searchSetup()
    for (const q of ['p', ' p ', 'x'.repeat(201)]) {
      const res = await as('employee').get(`/api/kb/articles?q=${encodeURIComponent(q)}`)
      expect({ q, status: res.status }).toEqual({ q, status: 422 })
      expect(res.body.errors).toEqual([expect.objectContaining({ field: 'q' })])
    }
    expect((await as('employee').get('/api/kb/articles?q=')).body.total).toBe(3)
  })

  test('search results page like any list, and a sort replaces relevance', async () => {
    const { as } = await searchSetup()
    const page1 = await as('employee').get('/api/kb/articles?q=printer&pageSize=1')
    expect(page1.body).toMatchObject({ total: 2, page: 1, pageSize: 1 })
    expect(page1.body.items.map((a) => a.title)).toEqual(['Printer toner replacement'])
    const byTitle = await as('employee').get('/api/kb/articles?q=printer&sort=title')
    expect(byTitle.body.items.map((a) => a.title)).toEqual(['Office equipment overview', 'Printer toner replacement'])
  })

  test('search text is never SQL: quotes and operators are just words', async () => {
    const { as } = await searchSetup()
    for (const q of ["printer' OR 1=1 --", '"printer"', '+printer -toner', 'printer*']) {
      const res = await as('employee').get(`/api/kb/articles?q=${encodeURIComponent(q)}`)
      expect({ q, status: res.status }).toEqual({ q, status: 200 })
      expect(res.body.items.every((a) => a.status === 'published')).toBe(true)
    }
  })
})

test('an article body of 100,000 multi-byte characters (well over the API-wide 100 KB) is accepted on /api/kb', async () => {
  const { as } = await setup()
  const email = await category(as)
  const res = await as('agent').post('/api/kb/articles', {
    title: 'Very long',
    body: 'ç'.repeat(100_000),
    category_id: email.id,
  })
  expect(res.status).toBe(201)
  // Other routes keep their 100 KB limit
  const ticket = await as('employee').post('/api/tickets', {
    title: 'Big',
    description: 'x'.repeat(200_000),
    category_id: 1,
  })
  expectError(ticket, 413, 'PAYLOAD_TOO_LARGE', 'Request body is too large (at most 100 KB)')
})
