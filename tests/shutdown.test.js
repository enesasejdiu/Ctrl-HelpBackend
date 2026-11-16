// Graceful shutdown (src/shutdown.js): on SIGTERM/SIGINT the server stops taking new requests, finishes the open ones,
// closes the MySQL pool and exits 0, within 10 seconds.
const http = require('http')
const net = require('net')
const path = require('path')
const { spawn } = require('child_process')
const { gracefulShutdown, handleShutdownSignals, SHUTDOWN_TIMEOUT_MS } = require('../src/shutdown')

const quietLog = { log: () => {}, error: () => {} }

// A server with /slow (answers when release() is called) and /fast routes, on a free port
async function startServer() {
  let release
  const released = new Promise((resolve) => (release = resolve))
  let slowStarted
  const slowRequestStarted = new Promise((resolve) => (slowStarted = resolve))
  const server = http.createServer(async (req, res) => {
    if (req.url === '/slow') {
      slowStarted()
      await released
    }
    res.end('done')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, port: server.address().port, release, slowRequestStarted }
}

function get(port, url) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: url, agent: false }, (res) => {
        let body = ''
        res.on('data', (chunk) => (body += chunk))
        res.on('end', () => resolve({ status: res.statusCode, body }))
      })
      .on('error', reject)
  })
}

const fakePool = () => ({ end: jest.fn().mockResolvedValue() })

describe('gracefulShutdown', () => {
  test('finishes a request already in progress, refuses new connections, then closes the pool: exit code 0', async () => {
    const { server, port, release, slowRequestStarted } = await startServer()
    const pool = fakePool()
    const open = get(port, '/slow')
    await slowRequestStarted

    const stopping = gracefulShutdown({ server, pool, log: quietLog })
    // No longer listening: a new connection is refused
    await expect(get(port, '/fast')).rejects.toThrow(/ECONNREFUSED/)
    // The pool stays open while a request may still need it
    expect(pool.end).not.toHaveBeenCalled()

    release()
    await expect(open).resolves.toEqual({ status: 200, body: 'done' })
    await expect(stopping).resolves.toBe(0)
    expect(pool.end).toHaveBeenCalledTimes(1)
  })

  test('stops the background timers and cron jobs', async () => {
    const { server } = await startServer()
    const tick = jest.fn()
    const timer = setInterval(tick, 5)
    const job = { stop: jest.fn() }
    await gracefulShutdown({ server, pool: fakePool(), timers: [timer], jobs: [job, null], log: quietLog })
    expect(job.stop).toHaveBeenCalledTimes(1)
    const ticks = tick.mock.calls.length
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(tick).toHaveBeenCalledTimes(ticks)
  })

  test('a request that never finishes is cut off at the deadline: exit code 1, and the pool is still closed', async () => {
    const { server, port, slowRequestStarted } = await startServer()
    const pool = fakePool()
    const log = { log: () => {}, error: jest.fn() }
    const open = get(port, '/slow')
    await slowRequestStarted

    await expect(gracefulShutdown({ server, pool, timeoutMs: 100, log })).resolves.toBe(1)
    await expect(open).rejects.toThrow(/socket hang up|ECONNRESET/)
    expect(pool.end).toHaveBeenCalledTimes(1)
    expect(log.error).toHaveBeenCalledWith(expect.stringMatching(/still open after 0.1 s/))
  })

  test('a failure closing the pool gives exit code 1', async () => {
    const { server } = await startServer()
    const pool = { end: jest.fn().mockRejectedValue(new Error('already closed')) }
    const log = { log: () => {}, error: jest.fn() }
    await expect(gracefulShutdown({ server, pool, log })).resolves.toBe(1)
    expect(log.error).toHaveBeenCalledWith(expect.stringMatching(/pool failed: already closed/))
  })

  test('cuts open requests off after 8 seconds by default, before the SIGKILL of docker stop at 10', () => {
    expect(SHUTDOWN_TIMEOUT_MS).toBe(8_000)
  })
})

describe('handleShutdownSignals', () => {
  test.each(['SIGTERM', 'SIGINT'])(
    '%s shuts down once and exits with the code; a second signal is ignored',
    async (signal) => {
      const { server } = await startServer()
      const pool = fakePool()
      const log = { log: jest.fn(), error: () => {} }
      let exited
      const exitCalled = new Promise((resolve) => (exited = resolve))
      const remove = handleShutdownSignals({ server, pool }, { exit: exited, log })
      try {
        // process.emit runs the handlers without really signalling Jest's own process
        process.emit(signal, signal)
        process.emit(signal, signal)
        await expect(exitCalled).resolves.toBe(0)
        expect(pool.end).toHaveBeenCalledTimes(1)
        expect(log.log).toHaveBeenCalledWith(`[shutdown] ${signal} received: no new requests, finishing open ones`)
        expect(log.log).toHaveBeenCalledWith(`[shutdown] ${signal} received again: still waiting for open requests`)
        expect(log.log).toHaveBeenCalledWith('[shutdown] Shut down cleanly')
      } finally {
        remove()
      }
    },
  )
})

describe('src/server.js', () => {
  const freePort = () =>
    new Promise((resolve) => {
      const probe = net.createServer().listen(0, '127.0.0.1', () => {
        const { port } = probe.address()
        probe.close(() => resolve(port))
      })
    })

  // The real server, on the throwaway test database (tests/setupEnv.js set DB_NAME, NODE_ENV=test and UPLOAD_DIR)
  test.each(['SIGTERM', 'SIGINT'])(
    'answers requests, then on %s exits 0 within 10 seconds after closing the pool',
    async (signal) => {
      const port = await freePort()
      const child = spawn(process.execPath, ['src/server.js'], {
        cwd: path.join(__dirname, '..'),
        env: { ...process.env, PORT: String(port), DOTENV_CONFIG_QUIET: 'true', LOG_LEVEL: 'info' },
      })
      let output = ''
      child.stdout.on('data', (chunk) => (output += chunk))
      child.stderr.on('data', (chunk) => (output += chunk))
      const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)))
      try {
        await new Promise((resolve, reject) => {
          const check = () => (/API running/.test(output) ? resolve() : null)
          child.stdout.on('data', check)
          child.on('exit', () => reject(new Error(`server exited early:\n${output}`)))
        })
        await expect(get(port, '/api/health')).resolves.toEqual({ status: 200, body: '{"status":"ok"}' })

        const sentAt = Date.now()
        child.kill(signal)
        await expect(exited).resolves.toBe(0)
        expect(Date.now() - sentAt).toBeLessThan(10_000)
        expect(output).toContain(`[shutdown] ${signal} received`)
        expect(output).toContain('[shutdown] Shut down cleanly')
      } finally {
        child.kill('SIGKILL')
      }
    },
    30000,
  )
})
