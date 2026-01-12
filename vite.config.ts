import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  base: '/hub/club-arena/',
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@components': path.resolve(__dirname, './src/components'),
      '@pages': path.resolve(__dirname, './src/pages'),
      '@stores': path.resolve(__dirname, './src/stores'),
      '@services': path.resolve(__dirname, './src/services'),
      '@types': path.resolve(__dirname, './src/types'),
      '@lib': path.resolve(__dirname, './src/lib'),
      // Local poker engine
      '@engine': path.resolve(__dirname, './src/engine'),
      // Diamond Arena services (for future shared logic)
      '@diamond': path.resolve(__dirname, '../club-engine/src/services'),
    },
  },
  server: {
    port: 5174, // Different port from Diamond Arena (5173)
    host: true,
  },
  define: {
    'process.env': {},
  }
})
