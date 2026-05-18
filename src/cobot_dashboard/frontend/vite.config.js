import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/ws': { target: 'ws://localhost:8080', ws: true },
      '/stream': 'http://localhost:8080',
      '/cmd': 'http://localhost:8080',
      '/health': 'http://localhost:8080',
      '/api': 'http://localhost:8080',
    },
  },
})
