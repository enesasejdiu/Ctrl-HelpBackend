const { captureLogs } = require('../src/logger')
// The central error handler (src/middleware/errors.js): unknown routes, a malformed JSON body, and unexpected
// server errors, which must answer with a safe message and never leak the details to the client.
const pool = require('../src/db')
const { api } = require('./helpers')

describe('error responses', () => {
  test('an unknown route is a 404 with a message', async () => {
    const res = await api.get('/api/no-such-route')
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ message: 'Route not found: GET /api/no-such-route' })
  })

  test('a malformed JSON body is a 400 "Request body is not valid JSON"', async () => {
    const res = await api.post('/api/auth/login').set('Content-Type', 'application/json').send('{"email": ')
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ message: 'Request body is not valid JSON' })
  })

  test('an unexpected error is a 500 with a safe message; the details are only logged on the server', async () => {
    const secret = 'connect ECONNREFUSED 10.0.0.5:3306 (internal detail)'
    const query = jest.spyOn(pool, 'query').mockRejectedValueOnce(new Error(secret))
    const logs = captureLogs()
    try {
      const res = await api.post('/api/auth/login').send({ email: 'someone@test.local', password: 'password123' })

      expect(res.status).toBe(500)
      const id = res.headers['x-request-id']
      expect(res.body).toEqual({ message: `Something went wrong (reference: ${id})`, request_id: id })
      expect(JSON.stringify(res.body)).not.toContain('ECONNREFUSED')
      expect(logs.text()).toContain(secret)
    } finally {
      query.mockRestore()
      logs.restore()
    }
  })
})
