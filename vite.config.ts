import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { sentryVitePlugin } from '@sentry/vite-plugin';
import path from 'path';

// https://vite.dev/config/
export default defineConfig({
  base: '/hub/club-arena/',
  plugins: [
    react(),

    // Sentry plugin for source maps and release tracking (production only)
    process.env.NODE_ENV === 'production' &&
      sentryVitePlugin({
        org: process.env.SENTRY_ORG || 'smarter-software-inc',
        project: process.env.SENTRY_PROJECT || 'javascript-react',
        authToken: process.env.SENTRY_AUTH_TOKEN,

        // Upload source maps
        sourcemaps: {
          assets: './dist/**',
          ignore: ['node_modules'],
        },

        // Release management
        release: {
          name: `club-arena@${process.env.npm_package_version || '1.0.0'}`,
          setCommits: {
            auto: true, // Automatically associate commits
          },
        },
      }),
  ].filter(Boolean), // Filter out false values when not in production
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@components': path.resolve(__dirname, './src/components'),
      '@lib': path.resolve(__dirname, './src/lib'),
      '@hooks': path.resolve(__dirname, './src/hooks'),
      '@stores': path.resolve(__dirname, './src/stores'),
      '@types': path.resolve(__dirname, './src/types'),
      '@services': path.resolve(__dirname, './src/services'),
      '@arena': path.resolve(__dirname, './src/arena'),
    },
  },
  server: {
    port: 5173,
    host: true,
  },
  define: {
    // Prevent process errors in browser
    'process.env': {},
  },
  build: {
    sourcemap: true, // Generate source maps for Sentry
    rollupOptions: {
      output: {
        manualChunks: {
          // Split vendor chunks — isolate heavy deps from main bundle
          'vendor-react': ['react', 'react-dom', 'react-router-dom'],
          'vendor-supabase': ['@supabase/supabase-js'],
          // 'vendor-three' REMOVED — three.js not imported anywhere, saves ~189KB
          'vendor-charts': ['recharts'],
          'vendor-motion': ['framer-motion'],
          'vendor-sentry': ['@sentry/react'],
        },
      },
    },
    chunkSizeWarningLimit: 600,
  },
});
