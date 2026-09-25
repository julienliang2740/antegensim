import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
// /api is proxied to the backend so the frontend can use a same-origin API base
// (VITE_API_BASE defaults to ""), which also keeps error bodies readable when the
// dev server falls back to another port.  Override the target with EMPYREAN_API_PROXY.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: process.env.EMPYREAN_API_PROXY ?? 'http://127.0.0.1:8000',
        changeOrigin: true,
      },
    },
  },
})
