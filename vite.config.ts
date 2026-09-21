import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { UI_PORT, SERVER_PORT } from './src/shared/ports.ts'

export default defineConfig({
  plugins: [react()],
  root: '.',
  server: {
    port: UI_PORT,
    strictPort: true,
    proxy: {
      '/api': `http://127.0.0.1:${SERVER_PORT}`,
      '/ws': { target: `ws://127.0.0.1:${SERVER_PORT}`, ws: true },
    },
  },
  build: { outDir: 'dist/ui', emptyOutDir: true },
})
