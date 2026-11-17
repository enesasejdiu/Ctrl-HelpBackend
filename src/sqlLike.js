// sqlLike.js – a LIKE pattern for "contains this text", with the text taken literally: % and _ in what the user typed
// are matched as characters, not as wildcards (a search for "50%" finds "50%", not every row with "50" in it).
// Use with `LIKE ? ESCAPE '!'`; '!' as the escape character works the same in every SQL mode (a backslash doesn't
// under NO_BACKSLASH_ESCAPES).
const LIKE_ESCAPE = "ESCAPE '!'"

function likeContains(text) {
  return `%${String(text).replace(/[!%_]/g, '!$&')}%`
}

module.exports = { likeContains, LIKE_ESCAPE }
