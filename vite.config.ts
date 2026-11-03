import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  base: './',
  plugins: [vue()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: { target: 'es2022' },
  // A shared CI runner is several times slower than a laptop, and a few tests walk thousands of loads.
  test: { testTimeout: 30_000 },
})
