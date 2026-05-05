import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // Use 'static/' for assets Vite copies into the build (headers, redirects).
  // This avoids conflict with the legacy 'public/' directory.
  publicDir: 'static',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
