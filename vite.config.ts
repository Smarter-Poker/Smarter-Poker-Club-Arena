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
        manualChunks(id: string) {
          // ── Vendor Splits (safe — no circular dependencies) ──
          if (id.includes('node_modules/react-dom')) return 'vendor-react';
          if (id.includes('node_modules/react-router')) return 'vendor-react';
          if (id.includes('node_modules/react/')) return 'vendor-react';
          if (id.includes('node_modules/@supabase/')) return 'vendor-supabase';
          if (id.includes('node_modules/recharts') || id.includes('node_modules/d3-'))
            return 'vendor-charts';
          if (id.includes('node_modules/framer-motion')) return 'vendor-motion';
          if (id.includes('node_modules/@sentry/')) return 'vendor-sentry';

          // ── Application code: let Vite handle splitting naturally ──
          // DO NOT manually chunk services, core, hooks, stores, or common components.
          // These layers have bidirectional imports (MasterBus ↔ services, common → core/services)
          // that create circular chunk dependencies, causing runtime module loading failures.
          // Vite's default splitting handles this correctly by co-locating tightly coupled modules.
        },
      },
    },
    chunkSizeWarningLimit: 600,
  },
});
