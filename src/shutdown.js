// Graceful shutdown for src/server.js. On SIGTERM (docker stop, most process managers) or SIGINT (Ctrl+C) the server
// stops accepting new connections, lets requests already in progress finish, closes the MySQL pool and exits 0.
// If open requests still haven't finished after 8 seconds, their connections are cut and the process exits 1, so a
// stuck request can never keep it from stopping. 8, not 10: docker stop sends SIGKILL after 10 seconds, and the pool
// still has to close (and the reason be logged) before that.

const SHUTDOWN_TIMEOUT_MS = 8_000

// Stops `server` and closes `pool`; also stops the background timers and cron jobs given. Resolves with the exit code:
// 0 when everything finished in time, 1 when open requests had to be cut off or something failed while closing.
async function gracefulShutdown({
  server,
  pool,
  timers = [],
  jobs = [],
  timeoutMs = SHUTDOWN_TIMEOUT_MS,
  log = console,
}) {
  for (const timer of timers) clearInterval(timer)
  for (const job of jobs) job?.stop()

  let exitCode = 0
  await new Promise((resolve) => {
    const deadline = setTimeout(() => {
      log.error(`[shutdown] Requests still open after ${timeoutMs / 1000} s: closing their connections`)
      exitCode = 1
      server.closeAllConnections()
    }, timeoutMs)
    // close() stops accepting connections and calls back once every open request has had its response. Kept-alive
    // connections with no request in progress are closed straight away, so an idle browser doesn't hold things up.
    server.close(() => {
      clearTimeout(deadline)
      resolve()
    })
    server.closeIdleConnections()
  })

  try {
    await pool.end()
  } catch (err) {
    log.error(`[shutdown] Closing the database pool failed: ${err.message}`)
    exitCode = 1
  }
  return exitCode
}

// Runs gracefulShutdown on the first SIGTERM or SIGINT, then exits with its code. A second signal while shutting down
// is only logged. Returns a function that removes the handlers (for the tests).
function handleShutdownSignals(options, { exit = process.exit, log = console } = {}) {
  let shuttingDown = false
  const onSignal = (signal) => {
    if (shuttingDown) {
      log.log(`[shutdown] ${signal} received again: still waiting for open requests`)
      return
    }
    shuttingDown = true
    log.log(`[shutdown] ${signal} received: no new requests, finishing open ones`)
    gracefulShutdown({ log, ...options }).then((code) => {
      log.log(code === 0 ? '[shutdown] Shut down cleanly' : '[shutdown] Shut down with errors')
      exit(code)
    })
  }
  process.on('SIGTERM', onSignal)
  process.on('SIGINT', onSignal)
  return () => {
    process.off('SIGTERM', onSignal)
    process.off('SIGINT', onSignal)
  }
}

module.exports = { gracefulShutdown, handleShutdownSignals, SHUTDOWN_TIMEOUT_MS }
