import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/ws':     { target: 'ws://localhost:8080',   ws: true,          changeOrigin: true },
      '/cmd':    { target: 'http://localhost:8080',                     changeOrigin: true },
      '/api':    { target: 'http://localhost:8080',                     changeOrigin: true },
      '/stream': { target: 'http://localhost:8080',                     changeOrigin: true },
      '/health': { target: 'http://localhost:8080',                     changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    emptyOutDir: true,
    chunkSizeWarningLimit: 2000,
  },
})
