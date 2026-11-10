// Smoke test: proves the test setup works (test database, app, login).
const { api, resetData, createUser, loginAs, auth, sessionOf } = require('./helpers')

beforeEach(resetData)

describe('basics', () => {
  test('GET /api/health returns 200', async () => {
    const res = await api.get('/api/health')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ status: 'ok' })
  })

  test('an unknown route returns 404 with a message', async () => {
    const res = await api.get('/api/does-not-exist')
    expect(res.status).toBe(404)
    expect(res.body.message).toMatch(/Route not found/)
  })
})

describe('login', () => {
  test('a created user can log in and gets a token', async () => {
    const user = await createUser()
    const res = await api.post('/api/auth/login').send({ email: user.email, password: user.password })
    expect(res.status).toBe(200)
    expect(sessionOf(res)).toEqual(expect.any(String))
    expect(res.body.user).toMatchObject({ id: user.id, email: user.email, role: 'employee' })
    expect(res.body.user).not.toHaveProperty('password_hash')
  })

  test('a wrong password returns 401', async () => {
    const user = await createUser()
    const res = await api.post('/api/auth/login').send({ email: user.email, password: 'wrong-password' })
    expect(res.status).toBe(401)
    expect(res.body.message).toBe('Wrong email or password')
  })
})

describe('GET /api/auth/me', () => {
  test('without a token returns 401', async () => {
    const res = await api.get('/api/auth/me')
    expect(res.status).toBe(401)
  })

  test('with a token returns 200 and the user', async () => {
    const user = await createUser({ role: 'agent' })
    const token = await loginAs(user)
    const res = await api.get('/api/auth/me').set(auth(token))
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ id: user.id, email: user.email, role: 'agent' })
  })
})

describe('roles', () => {
  test('an employee calling an admin-only route gets 403', async () => {
    const employee = await createUser({ role: 'employee' })
    const token = await loginAs(employee)
    const res = await api.get('/api/users').set(auth(token))
    expect(res.status).toBe(403)
  })
})
