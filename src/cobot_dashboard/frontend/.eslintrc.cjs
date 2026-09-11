// Minimal ESLint config focused on rules-of-hooks — the class of bug
// that caused React #300 (2026-07-16 incident). Kept small so `npm run
// lint` stays fast + green on the current codebase; add rules as we
// need them.
module.exports = {
  root: true,
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    ecmaFeatures: { jsx: true },
  },
  env: {
    browser: true,
    es2022: true,
    node: true,
  },
  // Vite-injected defines (see vite.config.js `define:` block). Listed
  // here so `no-undef` doesn't false-flag them.
  globals: {
    __COMMIT__:     'readonly',
    __BUILD_TIME__: 'readonly',
    __BUILD_ID__:   'readonly',
    __GIT_SHA__:    'readonly',
  },
  plugins: ['react-hooks'],
  rules: {
    'react-hooks/rules-of-hooks': 'error',
    'react-hooks/exhaustive-deps': 'warn',
    'no-undef': 'error',
  },
  ignorePatterns: ['build/', 'node_modules/', '../mock_server/static/**'],
}
