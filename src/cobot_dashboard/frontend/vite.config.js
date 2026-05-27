import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { execSync } from 'child_process'

const commitHash = (() => {
  try { return execSync('git rev-parse --short HEAD').toString().trim() }
  catch { return 'dev' }
})()

const buildTime = new Date().toISOString().slice(0, 16).replace('T', ' ')

export default defineConfig({
  plugins: [react()],
  define: {
    __COMMIT__:     JSON.stringify(commitHash),
    __BUILD_TIME__: JSON.stringify(buildTime),
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
