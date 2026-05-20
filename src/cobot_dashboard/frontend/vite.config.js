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
    // Build directly into the directory the FastAPI server already serves
    outDir: '../static',
    emptyOutDir: false,   // keep three.min.js / OrbitControls.js alongside
  },
})
