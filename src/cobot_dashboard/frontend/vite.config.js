import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { execSync } from 'child_process'
import { writeFileSync } from 'fs'
import { resolve } from 'path'

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

// Raw git SHA — the L257 like-for-like tell (2026-08-28). __BUILD_ID__
// above uses `git describe`, which is human-friendly but not equal
// shape to a bare `git rev-parse HEAD` string. The provenance handshake
// (WS reconnect / footer verdict) compares SHA-to-SHA between backend
// and frontend; both sides must emit the same shape or the compare is
// meaningless. Bake the raw SHA (40 hex) here + write it to a sidecar
// dist/.build-sha so the backend can read it too. `-dirty` suffix is
// preserved on dirty builds so a mismatch survives the diff.
const rawSha = (() => {
  try {
    const sha = execSync('git rev-parse HEAD').toString().trim()
    const dirty = execSync('git status --porcelain').toString().trim() !== ''
    return dirty ? `${sha}-dirty` : sha
  } catch { return 'unknown' }
})()

// Kept for backwards-compat with existing footer code that reads both;
// same content as buildId now.
const commitHash = buildId
const dirtyFlag = ''   // buildId already carries the -dirty suffix

// Second-precision build time — the per-build freshness signal.
const buildTime = new Date().toISOString().slice(0, 19).replace('T', ' ')

// Sidecar-write plugin — dist/.build-sha carries the raw git SHA so
// dashboard_server can read the frontend's SHA at request time (the JS
// bundle bakes its own copy for the client-side handshake). Written on
// every build, EMPTY-file safe if git fails.
const writeSidecarPlugin = {
  name: 'cobot-build-sha-sidecar',
  writeBundle(options) {
    const outDir = options.dir || resolve(process.cwd(), 'dist')
    try {
      writeFileSync(resolve(outDir, '.build-sha'), rawSha + '\n')
    } catch (e) {
      console.warn('[vite] failed to write .build-sha sidecar:', e.message)
    }
  },
}

export default defineConfig({
  plugins: [react(), writeSidecarPlugin],
  define: {
    __COMMIT__:     JSON.stringify(commitHash + dirtyFlag),
    __BUILD_TIME__: JSON.stringify(buildTime),
    __BUILD_ID__:   JSON.stringify(buildId),
    __GIT_SHA__:    JSON.stringify(rawSha),   // 2026-08-28: like-for-like
  },
  build: {
    // dist/ is vite's canonical outDir; dashboard_server serves from
    // frontend/dist directly (see _STATIC_DIR). The prior override
    // to '../mock_server/static' was a rsync-drift class: build
    // populated static/, System Check hashed dist/ (empty) and returned
    // 'Cannot verify'. Single source of truth here closes that class.
    outDir: 'dist',
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
