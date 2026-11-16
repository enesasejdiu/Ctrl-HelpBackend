// What happens on a crash: an exception nothing caught, or a promise rejection nobody handled (src/server.js installs
// this). It is logged at fatal with the stack, sent to Sentry if that is on (src/sentry.js), and then the process exits
// 1, as Node itself would; Docker (restart: unless-stopped) starts the API again.
const { logger: defaultLogger } = require('./logger')
const sentry = require('./sentry')

const CRASH_EVENTS = ['uncaughtException', 'unhandledRejection']

// Returns a function that removes the handlers (for the tests)
function installCrashHandlers({ proc = process, exit = process.exit, logger = defaultLogger, flushMs = 2000 } = {}) {
  let crashing = false
  const handlers = CRASH_EVENTS.map((event) => {
    const handler = (err) => {
      logger.fatal({ err }, `${event}: ${err?.message ?? err}`)
      if (crashing) return // a second crash while the first is being reported: logged, exit is already on its way
      crashing = true
      sentry.captureCrash(err, event)
      return sentry.flushSentry(flushMs).finally(() => exit(1))
    }
    proc.on(event, handler)
    return [event, handler]
  })
  return () => handlers.forEach(([event, handler]) => proc.off(event, handler))
}

module.exports = { installCrashHandlers, CRASH_EVENTS }
