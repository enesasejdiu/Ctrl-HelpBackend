// ESLint (v9 flat config): the recommended rules, with Node globals for the app and scripts and Jest globals for the
// tests. eslint-config-prettier comes last and turns off every rule that is about formatting, so ESLint and Prettier
// never disagree (Prettier owns the layout, ESLint the code). Run with npm run lint.
const js = require('@eslint/js')
const globals = require('globals')
const prettier = require('eslint-config-prettier')

module.exports = [
  { ignores: ['node_modules/', 'coverage/', 'backups/'] },
  js.configs.recommended,
  {
    // The backend is CommonJS (require / module.exports)
    files: ['**/*.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'commonjs', globals: globals.node },
    // const { secret, ...rest } = obj: taking fields out to use the rest is on purpose, so those aren't "unused"
    rules: { 'no-unused-vars': ['error', { ignoreRestSiblings: true }] },
  },
  {
    files: ['tests/**/*.js'],
    languageOptions: { globals: { ...globals.node, ...globals.jest } },
  },
  prettier,
]
