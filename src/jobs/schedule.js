// schedule.js – when the daily jobs run, with croner (a small cron library with time zones). The auto-close job
// (jobs/autoClose.js) runs every day at 03:00 Europe/Budapest by default:
//   AUTO_CLOSE_CRON      the cron expression (default "0 3 * * *": minute 0 of hour 3, every day)
//   AUTO_CLOSE_TIMEZONE  an IANA time zone (default "Europe/Budapest")
// The time zone is explicit, so the job runs at 03:00 local time in summer (CEST, 01:00 UTC) and winter (CET, 02:00 UTC),
// once a day also on the days the clocks change: 03:00 exists exactly once on both (the spring change skips 02:00–03:00,
// the autumn one repeats 02:00–03:00).
// It runs in the API process. protect: a run still going when the next one is due is skipped (the database lock in
// autoClose.js also keeps two processes from running at once). Nothing it does can crash the API: errors are logged.
const { Cron } = require('croner')
const { runAutoClose } = require('./autoClose')

const DEFAULT_CRON = '0 3 * * *'
const DEFAULT_TIMEZONE = 'Europe/Budapest'

const autoCloseCron = () => process.env.AUTO_CLOSE_CRON?.trim() || DEFAULT_CRON
const autoCloseTimezone = () => process.env.AUTO_CLOSE_TIMEZONE?.trim() || DEFAULT_TIMEZONE

// The next time the auto-close job runs after `from` (a Date), e.g. for tests and the startup log
function nextAutoCloseRun(from = new Date()) {
  const job = new Cron(autoCloseCron(), { timezone: autoCloseTimezone(), paused: true })
  const next = job.nextRun(from)
  job.stop()
  return next
}

// Starts the daily schedule. Returns the croner job (job.stop() ends it), or null if the settings are invalid: then the
// job is not scheduled, which is logged, and the API keeps running.
function startAutoCloseSchedule({ log = console } = {}) {
  let job
  try {
    job = new Cron(
      autoCloseCron(),
      { timezone: autoCloseTimezone(), protect: true, unref: true, name: 'auto-close' },
      async () => {
        try {
          await runAutoClose({ log })
        } catch (err) {
          log.error(`[auto-close] The job failed: ${err.message}`)
        }
      },
    )
  } catch (err) {
    log.error(`[auto-close] Not scheduled: invalid AUTO_CLOSE_CRON or AUTO_CLOSE_TIMEZONE (${err.message})`)
    return null
  }
  log.log(`[auto-close] Next run: ${job.nextRun()?.toISOString()} (${autoCloseCron()} ${autoCloseTimezone()})`)
  return job
}

module.exports = { startAutoCloseSchedule, nextAutoCloseRun, DEFAULT_CRON, DEFAULT_TIMEZONE }
