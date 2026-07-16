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
  plugins: ['react-hooks'],
  rules: {
    'react-hooks/rules-of-hooks': 'error',
    'react-hooks/exhaustive-deps': 'warn',
  },
  ignorePatterns: ['build/', 'node_modules/', '../mock_server/static/**'],
}
