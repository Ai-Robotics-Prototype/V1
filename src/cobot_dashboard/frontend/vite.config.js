import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
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
