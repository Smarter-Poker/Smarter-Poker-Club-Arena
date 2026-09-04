import { defineConfig } from 'vite';
import { cpus } from 'node:os';
import react from '@vitejs/plugin-react';
import { sentryVitePlugin } from '@sentry/vite-plugin';
import path from 'path';
import { writeFileSync } from 'fs';

// https://vite.dev/config/
export default defineConfig({
  base: '/hub/club-arena/',
  plugins: [
    react(),

    /**
     * ENTRY MODULE MANIFEST — what every player downloads before first paint.
     *
     * scripts/ci/entry-chunk-delta.mjs gates the module list of the entry
     * chunk against a committed baseline, so operator-only code cannot drift
     * into first paint unnoticed (it did on 2026-09-01, at a cost of ~190kB
     * raw). It originally read that list out of the entry chunk's sourcemap,
     * which worked locally and could never have worked in CI: the Sentry
     * plugin below uploads sourcemaps and then DELETES them from dist/, and it
     * only runs when SENTRY_AUTH_TOKEN is set, which is exactly CI and never a
     * developer's machine.
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

    // Sentry source-map upload + release tagging (Phase U5.1, task #133).
    // Gated on NODE_ENV=production AND SENTRY_AUTH_TOKEN so dev builds stay fast.
    // CI passes both via GitHub Actions secrets (`.github/workflows/ci.yml`).
    // Org/project slugs default to the LIVE Sentry values verified 2026-04-23
    // via the Sentry API: org `smarter-software-inc`, project `javascript-react`.
    // The earlier defaults (smarter-poker / club-arena) referenced a non-existent
    // org slug and uploads silently no-op'd — see task #133.
    !!(process.env.NODE_ENV === 'production' && process.env.SENTRY_AUTH_TOKEN) &&
      sentryVitePlugin({
        org: process.env.SENTRY_ORG || 'smarter-software-inc',
        project: process.env.SENTRY_PROJECT || 'javascript-react',
        authToken: process.env.SENTRY_AUTH_TOKEN,

        // Upload source maps, then DELETE them from dist/ so they don't ship
        // to end users (saves ~3 MB per deploy + avoids exposing source code).
        // Sentry keeps its own copy on the server side for symbolication.
        sourcemaps: {
          assets: './dist/**',
          ignore: ['node_modules'],
          filesToDeleteAfterUpload: ['./dist/**/*.js.map', './dist/**/*.css.map'],
        },

        // Release management.
        //
        // THIS NAME MUST EQUAL THE ONE THE RUNTIME REPORTS or symbolication
        // cannot work, and until 2026-09-04 it did not: this read
        // npm_package_version and tagged every upload `club-arena@1.0.1`,
        // while src/core/SentryInit.ts tags every event
        // `club-arena@${VITE_APP_VERSION}` - the publishing commit's sha. Two
        // different releases, so no event could ever find its maps. The
        // publisher sets VITE_APP_VERSION to the sha it is shipping; the
        // fallbacks below keep a local production build from throwing.
        release: {
          name: `club-arena@${process.env.VITE_APP_VERSION || process.env.npm_package_version || '1.0.0'}`,
          setCommits: {
            auto: true, // Automatically associate commits
          },
        },

        // Don't fail the build if Sentry upload fails
        errorHandler(err) {
          console.warn('[sentry-vite-plugin] Warning:', err.message);
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
    /**
     * Sentry ships its debug-logging paths behind these flags precisely so
     * bundlers can drop them. vendor-sentry is the largest single script the
     * app serves — 441 KB transferred, more than React (226 KB) and Supabase
     * (168 KB) combined — so every kilobyte that is dead code in production is
     * worth removing. Documented at
     * https://docs.sentry.io/platforms/javascript/configuration/tree-shaking/
     */
    __SENTRY_DEBUG__: false,
  },
  // Strip console.log/debug/debugger in production builds.
  // console.warn and console.error are preserved for Sentry error reporting.
  esbuild: {
    drop: process.env.NODE_ENV === 'production' ? ['debugger'] : [],
    pure:
      process.env.NODE_ENV === 'production' ? ['console.log', 'console.debug', 'console.info'] : [],
  },
  build: {
    sourcemap: true, // Enabled — Sentry source maps are uploaded for readable production stack traces
    // BUILD CONCURRENCY CAP, for the same reason vitest.config.ts caps its
    // thread pool: on CI this build does not own the machine.
    //
    // Rollup defaults maxParallelFileOps to 20. On a laptop that is free
    // speed. On an 8-core runner box hosting six runners it is six builds
    // each asking for twenty concurrent file operations, and the box goes to
    // load 63 - measured on estate-ci-eu-3, 2026-09-04, while estate-ci-eu-1
    // sat at 38 doing the same thing.
    //
    // A thrashing box does not merely build slowly. It times out tests that
    // pass in seconds elsewhere, and those timeouts are indistinguishable
    // from real failures, which is how a green suite turns into a red pull
    // request nobody can explain.
    //
    // Local builds are untouched: CI is capped, a laptop keeps the default.
    // Sized from the BOX for the same reason as vitest.config.ts: this was a
    // hard 4 for 8-core runners, and the boxes are 16-core since 2026-09-04.
    maxParallelFileOps: process.env.ROLLUP_MAX_FILE_OPS
      ? Number(process.env.ROLLUP_MAX_FILE_OPS)
      : process.env.CI
        ? Math.max(4, Math.floor(cpus().length / 2))
        : 20,
    rollupOptions: {
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
          if (id.includes('node_modules/@sentry/')) return 'vendor-sentry';
          // The narrow Sentry surface belongs IN that chunk. It is a handful of
          // re-exports, so Rollup would otherwise fold it into whichever chunk
          // imports it — the entry — and the entry would then carry a static
          // import of @sentry/*, dragging 80kB gzipped into the first paint that
          // is supposed to arrive after it. Verified by measurement, twice.
          if (id.includes('src/core/sentryBundle')) return 'vendor-sentry';

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
