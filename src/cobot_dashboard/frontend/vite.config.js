import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { execSync } from 'child_process'

const commitHash = (() => {
  try { return execSync('git rev-parse --short HEAD').toString().trim() }
  catch { return 'dev' }
})()

const dirtyFlag = (() => {
  try {
    const s = execSync('git status --porcelain').toString().trim()
    return s ? '-dirty' : ''
  } catch { return '' }
})()

const buildTime = new Date().toISOString().slice(0, 16).replace('T', ' ')

// Build-nonce — random 7-char id, changes every `npm run build`. The
// vite output filename already includes a content hash
// (assets/index-<hash>.js) but that hash isn't visible from inside the
// bundle at build time. The nonce gives the operator a per-build
// tag visible in the footer so a rebuild is obvious even without a
// new commit — solves the "blind footer" problem when working on
// uncommitted code.
const buildId = Math.random().toString(36).slice(2, 9)

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
