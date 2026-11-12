// slowHooks.js – a safety net for rare CI stalls: when a beforeEach / afterEach hook is still running after 5 s, it logs
// which hook (file:line), which helper step it was in (see step() below), and the database's PROCESSLIST at that
// moment; when the hook finishes, it logs how long it took in total. Normal runs print nothing.
//
// Loaded first in setupFilesAfterEnv, so it wraps every hook: the ones in setupAfterEnv.js and in each test file.
// The dump uses a connection of its own, never the app's pool, so a full or stuck pool can't block it.
const mysql = require('mysql2/promise')
const { loadServerSettings } = require('./testDb')

const SLOW_MS = 5000

// The helper step running right now, e.g. "resetData: TRUNCATE users" (one at a time: test files run their hooks in
// order, and maxWorkers is 1)
let currentStep = null

// Runs fn as a named step, so a slow-hook report can say where the time went
async function step(name, fn) {
  const outer = currentStep
  currentStep = name
  try {
    return await fn()
  } finally {
    currentStep = outer
  }
}

async function processList() {
  let connection
  try {
    connection = await mysql.createConnection({ ...loadServerSettings(), connectTimeout: 3000 })
    const [rows] = await connection.query(
      `SELECT ID, DB, COMMAND, TIME, STATE, LEFT(INFO, 200) AS INFO
       FROM information_schema.PROCESSLIST ORDER BY TIME DESC`,
    )
    return rows
  } catch (err) {
    return `PROCESSLIST unavailable: ${err.code || err.message}`
  } finally {
    await connection?.end().catch(() => {})
  }
}

// Where the hook was defined: the first stack line outside this file and Jest
function definedAt() {
  const line = new Error().stack
    .split('\n')
    .slice(1)
    .find((l) => !l.includes(__filename) && !l.includes('node_modules'))
  const match = line?.match(/\(?([^()\s]+:\d+):\d+\)?$/)
  return match ? match[1].replace(`${process.cwd()}/`, '') : 'unknown place'
}

// Wraps a hook so it reports itself when it runs longer than slowMs (5 s; tests pass less)
function watch(kind, fn, slowMs = SLOW_MS) {
  // Hooks that take a done callback are left alone (none do today)
  if (typeof fn !== 'function' || fn.length > 0) return fn
  const where = definedAt()
  return async function watchedHook() {
    const started = Date.now()
    let report = null
    const timer = setTimeout(() => {
      // Read now, while the hook is stuck: which test, which step
      const stuck = { hook: `${kind} at ${where}`, test: expect.getState().currentTestName, step: currentStep }
      report = processList().then((processlist) =>
        console.warn(
          `[slow hook] still running after ${slowMs / 1000} s\n${JSON.stringify({ ...stuck, processlist }, null, 2)}`,
        ),
      )
    }, slowMs)
    timer.unref()
    try {
      return await fn.call(this)
    } finally {
      clearTimeout(timer)
      if (report) {
        await report
        console.warn(`[slow hook] ${kind} at ${where} finished after ${Date.now() - started} ms`)
      }
    }
  }
}

for (const kind of ['beforeEach', 'afterEach']) {
  const original = globalThis[kind]
  globalThis[kind] = (fn, timeout) => original(watch(kind, fn), timeout)
}

module.exports = { step, watch, SLOW_MS }
