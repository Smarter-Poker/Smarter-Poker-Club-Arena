/**
 * Vite config for the PRERENDER build (see src/prerender/entry-server.tsx).
 *
 * AEO PHASE 1 (2026-09-17). A deliberately small config, not a merge of
 * vite.config.ts: the client config carries build-time side effects that must
 * not run for a second bundle. Its entry-module-manifest plugin overwrites
 * .entry-modules.json on every writeBundle, which scripts/ci/entry-chunk-delta
 * reads as the truth about the PLAYER's entry chunk; the media-identity plugin
 * renames assets by content. Neither belongs to a Node-side render.
 *
 * What is shared is what must be shared for a faithful render: the web base
 * (every asset URL and <Link> resolves to the public sub-path), the React
 * plugin, the path aliases (mirrored from vite.config.ts and tsconfig), and the
 * `process.env` define. The output is one Node module plus its CSS in
 * dist-prerender/, which scripts/prerender-public-routes.mjs consumes and which
 * is never published on its own (ignored by git).
 *
 * ssrEmitAssets is what makes the page CSS available to inline: an SSR build
 * strips CSS by default, and a prerendered page without its styles paints as
 * unstyled text for the second before the bundle boots.
 */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

const WEB_BASE = '/hub/club-arena/';

export default defineConfig({
  base: WEB_BASE,
  plugins: [react()],
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
  define: {
    'process.env': {},
  },
  build: {
    ssr: 'src/prerender/entry-server.tsx',
    outDir: 'dist-prerender',
    emptyOutDir: true,
    ssrEmitAssets: true,
    cssCodeSplit: false,
    minify: false,
    sourcemap: false,
    rollupOptions: {
      output: {
        entryFileNames: 'entry-server.mjs',
        chunkFileNames: 'chunks/[name].mjs',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
  ssr: {
    // Bundle the app's own modules and their dependencies so the script needs
    // no resolver tricks; React and the router stay external for a faithful
    // render with the installed versions.
    noExternal: [/^(?!react$|react-dom|react-router|react-router-dom)/],
  },
});
