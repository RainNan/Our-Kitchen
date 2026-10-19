import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  base: '/order/',
  plugins: [vue()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/order/api': 'http://127.0.0.1:3001', '/order/media': 'http://127.0.0.1:3001' },
  },
  build: { outDir: 'dist', sourcemap: false },
})
