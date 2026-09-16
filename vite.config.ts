import { defineConfig } from 'vite';
import { cpus } from 'node:os';
import react from '@vitejs/plugin-react';
import path from 'path';
import { writeFileSync } from 'fs';

/**
 * NATIVE BUILD TARGET (2026-09-07, docs/changelog/2026-09-07-capacitor-shell.md)
 *
 * `VITE_NATIVE=1` (`npm run build:native`) produces the bundle the Capacitor
 * shell copies into the iOS and Android apps. Inside that shell the bundle IS
 * the document root, so the base is '/' rather than the web sub-path, and it
 * lands in dist-native/ so it can never be mistaken for, or published as, the
 * web bundle. Without VITE_NATIVE every value below is exactly what it was:
 * the web build is byte-for-byte unaffected by the native target existing.
 *
 * The router basename, the service-worker path and every media address are
 * derived from BASE_URL (src/lib/appBase.ts), so this one switch is the only
 * place the two targets differ at build time.
 */
const NATIVE = process.env.VITE_NATIVE === '1';
const WEB_BASE = '/hub/club-arena/';
const maxParallelFileOps = process.env.ROLLUP_MAX_FILE_OPS
  ? Number(process.env.ROLLUP_MAX_FILE_OPS)
  : process.env.CI
    ? Math.max(4, Math.floor(cpus().length / 2))
    : 20;
// Rollup treats nonpositive limits as unbounded and does not reject NaN.
// Refuse an invalid cap before constructing any build or upload plugin.
if (!Number.isSafeInteger(maxParallelFileOps) || maxParallelFileOps <= 0) {
  throw new Error('ROLLUP_MAX_FILE_OPS must be a positive safe integer.');
}
// https://vite.dev/config/
export default defineConfig({
  base: NATIVE ? '/' : WEB_BASE,
  plugins: [
    react(),

    /**
     * ENTRY MODULE MANIFEST — what every player downloads before first paint.
     *
     * scripts/ci/entry-chunk-delta.mjs gates the module list of the entry
     * chunk against a committed baseline, so operator-only code cannot drift
     * into first paint unnoticed (it did on 2026-09-01, at a cost of ~190kB
     * raw). It originally read that list out of the entry chunk's sourcemap,
     * which depended on maps that are not part of published application output.
     *
     * Rollup already knows the answer, so ask it. Written on writeBundle
     * rather than emitted into the bundle so the list never ships to players.
     */
    {
      name: 'entry-module-manifest',
      writeBundle(_options: unknown, bundle: Record<string, unknown>) {
        const chunk = Object.values(bundle).find(
          (c) =>
            (c as { type?: string; isEntry?: boolean }).type === 'chunk' &&
            (c as { isEntry?: boolean }).isEntry
        ) as { fileName?: string; modules?: Record<string, unknown> } | undefined;
        if (!chunk?.modules) return;
        const modules = Object.keys(chunk.modules)
          .map((id) => id.replace(/\\/g, '/'))
          .filter((id) => id.includes('/src/') && !id.includes('/node_modules/'))
          .map((id) => 'src/' + id.slice(id.lastIndexOf('/src/') + 5))
          .filter((id) => !id.includes('\0'))
          .sort();
        writeFileSync(
          path.resolve('.entry-modules.json'),
          JSON.stringify({ entry: chunk.fileName, modules }, null, 2) + '\n'
        );
      },
    },
  ],
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
    // App.tsx intentionally requests the slashless Club Arena scope so the
    // World Hub's `/hub/club-arena` entry URL is controlled. Match the
    // production Vercel header in local/E2E serving; without it Chromium
    // rejects the first registration and emits a console error before the
    // default-scope fallback succeeds.
    headers: {
      'Service-Worker-Allowed': '/hub/club-arena',
    },
    /* Uploaded ad creatives are stored as same-origin paths
       (`/ad-creatives/club/<id>/<file>`); in production the World Hub
       rewrites that prefix to the `ad-creatives` storage bucket. The dev
       server does the same so a club owner's preview and the live rotator
       show the same picture locally. */
    proxy: {
      '/ad-creatives': {
        target: 'https://kuklfnapbkmacvwxktbh.supabase.co',
        changeOrigin: true,
        rewrite: (path) =>
          path.replace(/^\/ad-creatives/, '/storage/v1/object/public/ad-creatives'),
      },
    },
  },
  define: {
    // Prevent process errors in browser
    'process.env': {},
  },
  // Strip console.log/debug/debugger in production builds.
  // console.warn and console.error are preserved for operational diagnostics.
  esbuild: {
    drop: process.env.NODE_ENV === 'production' ? ['debugger'] : [],
    pure:
      process.env.NODE_ENV === 'production' ? ['console.log', 'console.debug', 'console.info'] : [],
  },
  build: {
    outDir: NATIVE ? 'dist-native' : 'dist',
    // Compress each emitted chunk without moving lazy modules into startup.
    // Keep CI resource usage bounded; Rollup owns the unchanged module graph.
    minify: 'terser',
    terserOptions: {
      maxWorkers: 2,
      compress: { passes: 2 },
      format: { comments: 'some' },
    },
    // Neither web nor native publication needs source maps.
    sourcemap: false,
    rollupOptions: {
      // Rollup defaults to 1000 concurrent file operations. Our intended
      // local cap is 20; shared CI hosts use half their CPUs, with a floor of 4.
      // This is a Rollup input option, so it belongs inside rollupOptions.
      // At the Vite build root it was ignored and the cap never took effect.
      maxParallelFileOps,
      output: {
        // 2026-04-15 cache-bust: append a build-time tag to every emitted
        // file's name so that v5-broken immutable caches on users' browsers
        // are bypassed. Vite's default content hash alone can't help here
        // because vendor chunks' content is unchanged — the tag forces a
        // brand-new URL even when content hash would otherwise match.
        entryFileNames: 'assets/[name]-[hash]-v6.js',
        chunkFileNames: 'assets/[name]-[hash]-v6.js',
        assetFileNames: 'assets/[name]-[hash]-v6[extname]',
        manualChunks(id: string) {
          // ── Vendor Splits (safe — no circular dependencies) ──
          if (id.includes('node_modules/react-dom')) return 'vendor-react';
          if (id.includes('node_modules/react-router')) return 'vendor-react';
          if (id.includes('node_modules/react/')) return 'vendor-react';
          if (id.includes('node_modules/@supabase/')) return 'vendor-supabase';
          // NOTE: recharts/d3 NOT manually chunked — they depend on React,
          // creating circular chunk deps (vendor-react ↔ vendor-charts).
          // Let Vite co-locate them naturally with their React dependency.
          if (id.includes('node_modules/framer-motion')) return 'vendor-motion';
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
