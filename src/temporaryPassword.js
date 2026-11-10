// Temporary passwords for accounts created or reset by an admin or HR (POST /api/users, POST /api/users/:id/reset-password).
// The user logs in with it once and must then choose their own (must_change_password).
const crypto = require('crypto')

// Letters and digits, minus look-alikes (0/O, 1/l/I), so the password can be read out or copied from a note
const PASSWORD_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
const TEMP_PASSWORD_LENGTH = 14

// A random temporary password with at least one letter and one digit.
// crypto.randomInt is cryptographically secure, unlike Math.random.
function makeTemporaryPassword() {
  for (;;) {
    const password = Array.from(
      { length: TEMP_PASSWORD_LENGTH },
      () => PASSWORD_CHARS[crypto.randomInt(PASSWORD_CHARS.length)],
    ).join('')
    // Draws without a letter or without a digit are very rare; just draw again
    if (/[a-zA-Z]/.test(password) && /\d/.test(password)) return password
  }
}

module.exports = { makeTemporaryPassword }
