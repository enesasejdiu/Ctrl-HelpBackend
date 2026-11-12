// Tests for tests/slowHooks.js, the slow-hook safety net: a hook slower than the limit reports which hook, test and
// step it was in, with the database's PROCESSLIST, then how long it took; a fast hook prints nothing.
const { step, watch } = require('./slowHooks')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let warn
beforeEach(() => {
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => warn.mockRestore())

test('a slow hook reports where it was stuck and the PROCESSLIST, then its total time', async () => {
  const hook = watch('beforeEach', () => step('demo: a slow step', () => sleep(400)), 100)

  await hook()

  expect(warn).toHaveBeenCalledTimes(2)
  const [first] = warn.mock.calls[0]
  expect(first).toMatch(/^\[slow hook\] still running after 0.1 s\n/)
  const report = JSON.parse(first.slice(first.indexOf('\n') + 1))
  expect(report).toMatchObject({
    hook: expect.stringMatching(/^beforeEach at tests\/slowHooks\.test\.js:\d+$/),
    test: 'a slow hook reports where it was stuck and the PROCESSLIST, then its total time',
    step: 'demo: a slow step',
  })
  // This connection's own query is always in the list
  expect(report.processlist).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ INFO: expect.stringContaining('information_schema.PROCESSLIST') }),
    ]),
  )
  expect(warn.mock.calls[1][0]).toMatch(
    /^\[slow hook\] beforeEach at tests\/slowHooks\.test\.js:\d+ finished after \d+ ms$/,
  )
})

test('a fast hook prints nothing, and its result and errors come through unchanged', async () => {
  expect(await watch('afterEach', async () => 'done', 100)()).toBe('done')
  await expect(watch('afterEach', async () => Promise.reject(new Error('boom')), 100)()).rejects.toThrow('boom')
  expect(warn).not.toHaveBeenCalled()
})

test('step() names the running step and restores the outer one, also after an error', async () => {
  const hook = watch(
    'afterEach',
    () =>
      step('outer', async () => {
        await step('inner', () => Promise.reject(new Error('inner failed'))).catch(() => {})
        await sleep(300)
      }),
    100,
  )

  await hook()

  expect(JSON.parse(warn.mock.calls[0][0].split('\n').slice(1).join('\n')).step).toBe('outer')
})
