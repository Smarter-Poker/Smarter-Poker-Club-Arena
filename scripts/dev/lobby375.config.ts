/**
 * A vitest config for ONE dev check: scripts/dev/lobby-card-shot.tsx renders the
 * real LobbyTable with the real stylesheet in real Chromium at 375px and fails
 * if any cell is clipped or the page scrolls sideways.
 *
 * Deliberately NOT under tests/ and deliberately not merged with the root
 * config (mergeConfig CONCATENATES `include`, which pulls the whole suite in).
 * CI must never need a browser to publish the bundle. Run it by hand:
 *   npx vitest run --config scripts/dev/lobby375.config.ts
 */
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

/* LobbyTable pulls in useSpinTierAvailability, which constructs the Supabase
   client at module scope and throws without these. The harness never makes a
   request — it only needs the module to load — so a placeholder is enough and
   nothing real is ever contacted. */
process.env.VITE_SUPABASE_URL ||= 'http://localhost:54321';
process.env.VITE_SUPABASE_ANON_KEY ||= 'harness-anon-key';

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'node',
    env: {
      VITE_SUPABASE_URL: process.env.VITE_SUPABASE_URL,
      VITE_SUPABASE_ANON_KEY: process.env.VITE_SUPABASE_ANON_KEY,
    },
    include: ['scripts/dev/lobby-card-shot.tsx'],
    testTimeout: 120000,
    hookTimeout: 120000,
  },
  resolve: {
    alias: {
      'canvas-confetti': path.resolve(__dirname, '../../tests/stubs/canvas-confetti.ts'),
      '@': path.resolve(__dirname, '../../src'),
    },
  },
});
