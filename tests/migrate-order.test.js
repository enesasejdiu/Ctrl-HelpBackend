// Tests for the order rule in scripts/migrate.js (findPending): a new migration numbered below one that already ran is
// refused, except exactly 013_list_sort_indexes.sql and 014_forgot_password_tokens.sql (MAY_RUN_AFTER_HIGHER), which
// were merged after 015 and 016 had been applied to existing databases.
const { findPending, MAY_RUN_AFTER_HIGHER } = require('../scripts/migrate')

const MAIN = [
  '012_attachments.sql',
  '013_list_sort_indexes.sql',
  '014_forgot_password_tokens.sql',
  '015_settings.sql',
  '016_auto_close.sql',
]
const files = (names) => names.map((file) => ({ file, checksum: `sum-${file}` }))
const applied = (names) => names.map((filename) => ({ filename, checksum: `sum-${filename}` }))
const pendingNames = (migrations, done) => findPending(files(migrations), applied(done)).map((m) => m.file)

test('the allowlist is exactly 013 and 014', () => {
  expect([...MAY_RUN_AFTER_HIGHER]).toEqual(['013_list_sort_indexes.sql', '014_forgot_password_tokens.sql'])
})

test('a database with 015 applied (but not 013, 014, 016) gets 013, 014 and 016, in number order', () => {
  expect(pendingNames(MAIN, ['012_attachments.sql', '015_settings.sql'])).toEqual([
    '013_list_sort_indexes.sql',
    '014_forgot_password_tokens.sql',
    '016_auto_close.sql',
  ])
})

test('a database with 015 and 016 applied gets 013 and 014', () => {
  expect(pendingNames(MAIN, ['012_attachments.sql', '015_settings.sql', '016_auto_close.sql'])).toEqual([
    '013_list_sort_indexes.sql',
    '014_forgot_password_tokens.sql',
  ])
})

test('a database built from main has nothing to do', () => {
  expect(pendingNames(MAIN, MAIN)).toEqual([])
})

test('any other new file numbered below an applied one is still refused', () => {
  const withNew = [...MAIN.slice(0, 4), '015_zz_late.sql', '016_auto_close.sql'].sort()
  expect(() => pendingNames(withNew, MAIN)).toThrow(
    '015_zz_late.sql is new but numbered below 016_auto_close.sql, which is already applied. Renumber it',
  )
})

test('a new file above the highest applied one is fine', () => {
  expect(pendingNames([...MAIN, '017_next.sql'], MAIN)).toEqual(['017_next.sql'])
})
