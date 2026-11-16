// The safety check every suite runs before creating data (tests/support/guard.js, called from setupAfterEnv.js)
const { assertThrowawayDb, allowedHosts } = require('./support/guard')

const saved = { DB_NAME: process.env.DB_NAME, DB_HOST: process.env.DB_HOST, extra: process.env.TEST_DB_ALLOWED_HOSTS }
afterEach(() => {
  process.env.DB_NAME = saved.DB_NAME
  process.env.DB_HOST = saved.DB_HOST
  process.env.TEST_DB_ALLOWED_HOSTS = saved.extra ?? ''
})

test('passes on this run’s throwaway database', async () => {
  await expect(assertThrowawayDb()).resolves.toEqual({ name: saved.DB_NAME, host: expect.any(String) })
})

test.each(['ticketflow', 'ticketflow_prod', 'production', '', 'ticketflow_test_x; DROP DATABASE ticketflow'])(
  'refuses the database name %j',
  async (name) => {
    process.env.DB_NAME = name
    await expect(assertThrowawayDb()).rejects.toThrow(/Refusing to run/)
  },
)

test.each(['db.prod.example.com', '10.0.0.5', 'mysql.internal'])('refuses the remote host %j', async (host) => {
  process.env.DB_HOST = host
  await expect(assertThrowawayDb()).rejects.toThrow(/Refusing to run: DB_HOST/)
})

test('TEST_DB_ALLOWED_HOSTS adds a throwaway host', () => {
  process.env.TEST_DB_ALLOWED_HOSTS = 'ci-db, Throwaway.Local '
  expect(allowedHosts()).toEqual(expect.arrayContaining(['ci-db', 'throwaway.local', 'localhost']))
})
