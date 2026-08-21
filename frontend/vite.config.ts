import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'
import { APP_BASE } from './vite-base.config'

export default defineConfig({
  plugins: [react()],
  base: APP_BASE,
  test: {
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    // umbrella #432 §C: without this, Vitest stubs every `.css` import to an
    // empty string regardless of query suffix — formFieldPrimitive.test.tsx
    // reads index.css via `?raw` specifically so its contrast assertion is
    // computed from the real, shipped stylesheet text rather than a value
    // copied into TS. No existing test imports CSS at all, so this has no
    // effect on anything already passing.
    css: true,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
      '/auth': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: '../src/dmf_cms/static/app',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        entryFileNames: '[name]-[hash].js',
        chunkFileNames: '[name]-[hash].js',
        assetFileNames: '[name]-[hash][extname]',
      },
    },
  },
})
