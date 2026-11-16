// Satisfaction ratings: POST /api/tickets/:id/rating, `rating` on GET /api/tickets/:id and `ratings` on GET /api/stats
// (migration 017). The requester rates their closed ticket once, 1–5 stars and an optional comment.
const pool = require('../src/db')
const { api, resetData, createUser, loginAs, auth, expectError, dbSnapshot } = require('./helpers')

let requester
let other
let agent
let agent2
let admin

beforeEach(async () => {
  await resetData()
  requester = await createUser({ role: 'employee', name: 'Rita Requester' })
  other = await createUser({ role: 'employee' })
  agent = await createUser({ role: 'agent', name: 'Alice Agent' })
  agent2 = await createUser({ role: 'agent', name: 'Bob Agent' })
  admin = await createUser({ role: 'admin', name: 'Ada Admin' })
  for (const user of [requester, other, agent, agent2, admin]) user.token = await loginAs(user)
})

// A ticket by `by`, taken through the real flow: assigned (optional), resolved by the admin, then closed by `by`
async function closedTicket({ by = requester, assignee = agent, close = true } = {}) {
  const created = await api
    .post('/api/tickets')
    .set(auth(by.token))
    .send({ title: 'Laptop will not charge', description: 'The charger light stays off.', category_id: 1 })
  expect(created.status).toBe(201)
  const id = created.body.id
  if (assignee) {
    const assigned = await api
      .patch(`/api/tickets/${id}/assign`)
      .set(auth(admin.token))
      .send({ assigned_to: assignee.id })
    expect(assigned.status).toBe(200)
  }
  const resolved = await api
    .patch(`/api/tickets/${id}/status`)
    .set(auth(admin.token))
    .send({ status: 'resolved', resolution: 'Replaced the charger.' })
  expect(resolved.status).toBe(200)
  if (close) {
    const closed = await api.patch(`/api/tickets/${id}/status`).set(auth(by.token)).send({ status: 'closed' })
    expect(closed.status).toBe(200)
  }
  return id
}

const rate = (id, body, user = requester) => api.post(`/api/tickets/${id}/rating`).set(auth(user.token)).send(body)
const ratingRows = async () => (await pool.query('SELECT * FROM ticket_ratings ORDER BY id'))[0]
const stats = async () => (await api.get('/api/stats').set(auth(admin.token))).body.ratings

describe('rating a closed ticket', () => {
  test('the requester rates it: 201 with the rating, which the ticket then shows to everyone who can see it', async () => {
    const id = await closedTicket()
    const res = await rate(id, { stars: 4, comment: '  Quick and friendly  ' })
    expect(res.status).toBe(201)
    expect(res.body).toEqual({ stars: 4, comment: 'Quick and friendly', created_at: expect.any(String) })
    expect(Object.keys(res.body).sort()).toEqual(['comment', 'created_at', 'stars'])

    for (const viewer of [requester, agent, admin]) {
      const ticket = await api.get(`/api/tickets/${id}`).set(auth(viewer.token))
      expect(ticket.status).toBe(200)
      expect(ticket.body.rating).toEqual(res.body)
    }
    expect(await ratingRows()).toMatchObject([
      { ticket_id: id, rated_by: requester.id, agent_id: agent.id, stars: 4, comment: 'Quick and friendly' },
    ])
  })

  test('a ticket that has not been rated has rating: null (the frontend tells "not rated" from "no ratings")', async () => {
    const id = await closedTicket()
    const ticket = await api.get(`/api/tickets/${id}`).set(auth(requester.token))
    expect(ticket.body).toHaveProperty('rating', null)
  })

  test('the comment is optional; left out, null, empty or only spaces is stored as none', async () => {
    for (const body of [
      { stars: 5 },
      { stars: 5, comment: null },
      { stars: 5, comment: '' },
      { stars: 5, comment: '   ' },
    ]) {
      const id = await closedTicket()
      const res = await rate(id, body)
      expect(res.status).toBe(201)
      expect(res.body.comment).toBeNull()
    }
  })

  test('1 and 5 stars and a 500-character comment are accepted', async () => {
    const low = await rate(await closedTicket(), { stars: 1 })
    const high = await rate(await closedTicket(), { stars: 5, comment: 'x'.repeat(500) })
    expect([low.status, high.status]).toEqual([201, 201])
    expect(high.body.comment).toHaveLength(500)
  })

  test('an unassigned ticket can be rated; the rating has no agent', async () => {
    const id = await closedTicket({ assignee: null })
    expect((await rate(id, { stars: 3 })).status).toBe(201)
    expect((await ratingRows())[0].agent_id).toBeNull()
  })

  test('staff who reported a ticket themselves rate it like anyone else', async () => {
    const id = await closedTicket({ by: agent2, assignee: agent })
    expect((await rate(id, { stars: 5 }, agent2)).status).toBe(201)
  })
})

describe('who may rate, when, and how often', () => {
  test('rated once: a second rating is 409 ALREADY_RATED and the first one is kept', async () => {
    const id = await closedTicket()
    expect((await rate(id, { stars: 2, comment: 'Slow' })).status).toBe(201)
    const again = await rate(id, { stars: 5, comment: 'Changed my mind' })
    expectError(again, 409, 'ALREADY_RATED')
    expect(await ratingRows()).toMatchObject([{ stars: 2, comment: 'Slow' }])
  })

  test('reopened and closed again after rating: still 409, one rating per ticket', async () => {
    const id = await closedTicket()
    expect((await rate(id, { stars: 4 })).status).toBe(201)
    expect(
      (await api.patch(`/api/tickets/${id}/status`).set(auth(requester.token)).send({ status: 'reopened' })).status,
    ).toBe(200)
    // While reopened the rating is still there, and asking again says so (not "not closed")
    expectError(await rate(id, { stars: 1 }), 409, 'ALREADY_RATED')
    expect((await api.get(`/api/tickets/${id}`).set(auth(requester.token))).body.rating.stars).toBe(4)
    expect(await ratingRows()).toHaveLength(1)
  })

  test('two ratings at the same moment (two tabs): exactly one is saved, the other gets 409', async () => {
    const id = await closedTicket()
    const results = await Promise.all([rate(id, { stars: 3 }), rate(id, { stars: 5 })])
    expect(results.map((r) => r.status).sort()).toEqual([201, 409])
    expectError(
      results.find((r) => r.status === 409),
      409,
      'ALREADY_RATED',
    )
    expect(await ratingRows()).toHaveLength(1)
  })

  test('a ticket that is not closed: 400 TICKET_NOT_CLOSED, whatever its status, and nothing is saved', async () => {
    const id = await closedTicket({ close: false }) // resolved
    expectError(await rate(id, { stars: 4 }), 400, 'TICKET_NOT_CLOSED')
    for (const status of ['open', 'assigned', 'in_progress', 'waiting_for_user', 'reopened']) {
      await pool.query('UPDATE tickets SET status = ? WHERE id = ?', [status, id])
      expectError(await rate(id, { stars: 4 }), 400, 'TICKET_NOT_CLOSED')
    }
    expect(await ratingRows()).toHaveLength(0)
  })

  test('staff who can see the ticket but did not report it: 403 NOT_REQUESTER, nothing saved', async () => {
    const id = await closedTicket()
    for (const user of [agent, agent2, admin]) {
      expectError(await rate(id, { stars: 5 }, user), 403, 'NOT_REQUESTER')
    }
    expect(await ratingRows()).toHaveLength(0)
  })

  test("another employee can't even see the ticket: 403, nothing saved", async () => {
    const id = await closedTicket()
    expect((await rate(id, { stars: 1 }, other)).status).toBe(403)
    expect(await ratingRows()).toHaveLength(0)
  })

  test('an unknown ticket is 404; logged out is 401', async () => {
    expect((await rate(999999, { stars: 4 })).status).toBe(404)
    const id = await closedTicket()
    expect((await api.post(`/api/tickets/${id}/rating`).send({ stars: 4 })).status).toBe(401)
    expect(await ratingRows()).toHaveLength(0)
  })
})

describe('invalid ratings: 400 with the field and a message ready to show, nothing saved', () => {
  const cases = [
    ['no stars', {}, 'stars', 'Choose from 1 to 5 stars'],
    ['0 stars', { stars: 0 }, 'stars', 'Choose from 1 to 5 stars'],
    ['6 stars', { stars: 6 }, 'stars', 'Choose from 1 to 5 stars'],
    ['half a star', { stars: 3.5 }, 'stars', 'Choose from 1 to 5 stars'],
    ['stars as text', { stars: '4' }, 'stars', 'Choose from 1 to 5 stars'],
    ['stars: null', { stars: null }, 'stars', 'Choose from 1 to 5 stars'],
    [
      'a 501-character comment',
      { stars: 4, comment: 'x'.repeat(501) },
      'comment',
      'Comment must be 500 characters or less',
    ],
    ['a comment that is not text', { stars: 4, comment: 42 }, 'comment', 'Comment must be text'],
    ['an unknown field', { stars: 4, agent_id: 1 }, 'agent_id', 'agent_id is not allowed'],
  ]
  test.each(cases)('%s', async (_, body, field, message) => {
    const id = await closedTicket()
    const before = await dbSnapshot()
    const res = await rate(id, body)
    expect(res.status).toBe(400)
    expect(res.body.errors).toContainEqual({ field, message })
    expect(await dbSnapshot()).toEqual(before)
  })
})

describe('GET /api/stats: ratings', () => {
  test('no ratings yet: average null, count 0, and every active agent/admin listed with none', async () => {
    expect(await stats()).toEqual({
      average: null,
      count: 0,
      byAgent: expect.arrayContaining([
        { name: 'Alice Agent', average: null, count: 0 },
        { name: 'Bob Agent', average: null, count: 0 },
        { name: 'Ada Admin', average: null, count: 0 },
      ]),
    })
    expect((await stats()).byAgent).toHaveLength(3)
  })

  test('the average over all ratings (1 decimal) and per agent who held the ticket; unassigned counts only in the total', async () => {
    for (const [stars, assignee] of [
      [4, agent],
      [5, agent],
      [4, agent],
      [2, agent2],
      [1, null],
    ]) {
      expect((await rate(await closedTicket({ assignee }), { stars })).status).toBe(201)
    }
    const ratings = await stats()
    expect(ratings.average).toBe(3.2) // 16 / 5
    expect(ratings.count).toBe(5)
    // Most ratings first, then by name
    expect(ratings.byAgent).toEqual([
      { name: 'Alice Agent', average: 4.3, count: 3 }, // 13 / 3 = 4.33
      { name: 'Bob Agent', average: 2, count: 1 },
      { name: 'Ada Admin', average: null, count: 0 },
    ])
    expect(typeof ratings.average).toBe('number')
  })

  test('the agent is the one who held the ticket when it was rated: reassigning it later changes nothing', async () => {
    const id = await closedTicket({ assignee: agent })
    expect((await rate(id, { stars: 5 })).status).toBe(201)
    expect(
      (await api.patch(`/api/tickets/${id}/assign`).set(auth(admin.token)).send({ assigned_to: agent2.id })).status,
    ).toBe(200)
    const byName = Object.fromEntries((await stats()).byAgent.map((a) => [a.name, a]))
    expect(byName['Alice Agent']).toMatchObject({ average: 5, count: 1 })
    expect(byName['Bob Agent']).toMatchObject({ average: null, count: 0 })
  })

  test('a deactivated agent is left out of byAgent (like the workload table), but their ratings still count in total', async () => {
    expect((await rate(await closedTicket({ assignee: agent2 }), { stars: 2 })).status).toBe(201)
    await pool.query('UPDATE users SET is_active = FALSE WHERE id = ?', [agent2.id])
    const ratings = await stats()
    expect(ratings).toMatchObject({ average: 2, count: 1 })
    expect(ratings.byAgent.map((a) => a.name)).not.toContain('Bob Agent')
  })

  test('deleting a ticket deletes its rating (ON DELETE CASCADE)', async () => {
    const id = await closedTicket()
    expect((await rate(id, { stars: 5 })).status).toBe(201)
    await pool.query('DELETE FROM attachments WHERE ticket_id = ?', [id])
    await pool.query('DELETE FROM ticket_history WHERE ticket_id = ?', [id])
    await pool.query('DELETE FROM comments WHERE ticket_id = ?', [id])
    await pool.query('DELETE FROM tickets WHERE id = ?', [id])
    expect(await ratingRows()).toHaveLength(0)
    expect(await stats()).toMatchObject({ average: null, count: 0 })
  })
})

describe('the database itself', () => {
  test('refuses stars outside 1–5 and a second rating for the same ticket, even without the API', async () => {
    const id = await closedTicket()
    const insert = (stars) =>
      pool.query('INSERT INTO ticket_ratings (ticket_id, rated_by, stars) VALUES (?, ?, ?)', [id, requester.id, stars])
    await expect(insert(0)).rejects.toThrow()
    await expect(insert(6)).rejects.toThrow()
    await insert(3)
    await expect(insert(4)).rejects.toMatchObject({ code: 'ER_DUP_ENTRY' })
  })
})
