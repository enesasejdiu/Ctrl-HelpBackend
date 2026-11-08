// Session cookies: what login sets and logout clears.
//   tf_session – the JWT. httpOnly, so page scripts (and anything injected into the page) can't read it.
//   tf_csrf    – a random value the frontend CAN read and must send back as the X-CSRF-Token header on every
//                POST/PATCH/PUT/DELETE authenticated by the cookie (double-submit; checked in middleware/auth.js).
//                Another site can make the browser send the cookies, but it can't read tf_csrf to copy it into the header.
// Both: sameSite "lax", path "/", secure in production (HTTPS only), and they last as long as the token (8 hours).
const crypto = require('crypto');

const SESSION_COOKIE = 'tf_session';
const CSRF_COOKIE = 'tf_csrf';
const CSRF_HEADER = 'x-csrf-token';
const SESSION_HOURS = 8;
const SESSION_MAX_AGE_MS = SESSION_HOURS * 60 * 60 * 1000;

// Read on every call, so NODE_ENV can be changed in tests
function baseOptions() {
  return { sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/' };
}

// Sets both cookies after a successful login
function setSessionCookies(res, token) {
  res.cookie(SESSION_COOKIE, token, { ...baseOptions(), httpOnly: true, maxAge: SESSION_MAX_AGE_MS });
  res.cookie(CSRF_COOKIE, crypto.randomBytes(32).toString('hex'), {
    ...baseOptions(),
    httpOnly: false,
    maxAge: SESSION_MAX_AGE_MS,
  });
}

// Removes both cookies (the options must match the ones they were set with, or the browser keeps them)
function clearSessionCookies(res) {
  res.clearCookie(SESSION_COOKIE, { ...baseOptions(), httpOnly: true });
  res.clearCookie(CSRF_COOKIE, { ...baseOptions(), httpOnly: false });
}

// Constant-time comparison, so the check doesn't leak how much of a guess was right
function csrfMatches(cookieValue, headerValue) {
  if (typeof cookieValue !== 'string' || typeof headerValue !== 'string' || !cookieValue) return false;
  const a = Buffer.from(cookieValue);
  const b = Buffer.from(headerValue);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = {
  SESSION_COOKIE,
  CSRF_COOKIE,
  CSRF_HEADER,
  SESSION_HOURS,
  SESSION_MAX_AGE_MS,
  setSessionCookies,
  clearSessionCookies,
  csrfMatches,
};
