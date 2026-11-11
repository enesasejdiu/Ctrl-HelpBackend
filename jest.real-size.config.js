// Jest config for the one real-size attachment test (tests/real-size/): the same setup as jest.config.js, but only that
// folder, in its own Jest run (npm run test:real-size, also run by npm test and npm run test:coverage), so its 10 MB
// file never shares a process with the other tests. No coverage thresholds: the main run measures coverage.
const base = require('./jest.config')

module.exports = {
  ...base,
  testMatch: ['<rootDir>/tests/real-size/**/*.test.js'],
  testPathIgnorePatterns: ['/node_modules/'],
  coverageThreshold: undefined,
}
