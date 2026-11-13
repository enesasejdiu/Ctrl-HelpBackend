// Runs Jest several times in a row and stops at the first failing run: a check that suites pass reliably, not just once.
//   npm run test:repeat                      the email, upload and pagination suites, 3 times
//   node scripts/repeat-tests.js 5 tests/attachments.test.js   any suites, any number of times
// Each run is a fresh Jest process: its own throwaway ticketflow_test_* database, UPLOAD_DIR and fake SMTP port.
const { spawnSync } = require('child_process')
const path = require('path')

const DEFAULT_SUITES = [
  'tests/email-smtp.test.js',
  'tests/attachments.test.js',
  'tests/pagination.test.js',
  'tests/pagination-edge.test.js',
]

const [timesArg, ...suites] = process.argv.slice(2)
const times = Number(timesArg) || 3
const jest = path.join(__dirname, '..', 'node_modules', 'jest', 'bin', 'jest.js')

for (let run = 1; run <= times; run += 1) {
  console.log(`\n[repeat] Run ${run} of ${times}`)
  const result = spawnSync(process.execPath, [jest, ...(suites.length ? suites : DEFAULT_SUITES)], { stdio: 'inherit' })
  if (result.status !== 0) {
    console.error(`[repeat] Run ${run} of ${times} failed`)
    process.exit(result.status ?? 1)
  }
}
console.log(`\n[repeat] All ${times} runs passed`)
