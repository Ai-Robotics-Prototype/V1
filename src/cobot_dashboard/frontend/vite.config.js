import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { execSync } from 'child_process'

// Footer identity — `git describe --always --dirty` at build time. Always
// emits SOMETHING (falls back to the short hash when no tags exist) and
// suffixes -dirty when the working tree has uncommitted changes. This
// replaces a random per-build nonce that had burned us as a verification
// tell: two independent random values had shown up looking similar
// enough to be misread as "same build". `git describe` is deterministic
// per tree state, and __BUILD_TIME__ below (now second-precision) is the
// per-build freshness signal — two rebuilds on the same tree share the
// __BUILD_ID__ string but always differ on __BUILD_TIME__.
const buildId = (() => {
  try { return execSync('git describe --always --dirty').toString().trim() }
  catch { return 'dev' }
})()

// Kept for backwards-compat with existing footer code that reads both;
// same content as buildId now.
const commitHash = buildId
const dirtyFlag = ''   // buildId already carries the -dirty suffix

// Second-precision build time — the per-build freshness signal.
const buildTime = new Date().toISOString().slice(0, 19).replace('T', ' ')

export default defineConfig({
  plugins: [react()],
  define: {
    __COMMIT__:     JSON.stringify(commitHash + dirtyFlag),
    __BUILD_TIME__: JSON.stringify(buildTime),
    __BUILD_ID__:   JSON.stringify(buildId),
  },
  build: {
    outDir: '../mock_server/static',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/ws':     { target: 'ws://localhost:8080', ws: true, changeOrigin: true },
      '/stream': { target: 'http://localhost:8080', changeOrigin: true },
      '/cmd':    { target: 'http://localhost:8080', changeOrigin: true },
      '/api':    { target: 'http://localhost:8080', changeOrigin: true },
      '/health': { target: 'http://localhost:8080', changeOrigin: true },
    },
  },
})
