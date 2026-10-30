import { defineConfig } from 'vitest/config';
import { availableParallelism } from 'node:os';
import { clientVitestWorkerBudget } from './scripts/ci/client-vitest-worker-budget.mjs';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react({ jsxImportSource: '@arena-display' })],
  test: {
    globals: true,
    // Complete-corpus source scans take up to20.1s on the shared SSD.
    // The harness needs finite headroom; assertions, product deadlines and
    // the separate server suite's timeout remain unchanged.
    testTimeout: 30_000,
    // happy-dom, NOT jsdom. Changed 2026-08-23 for cost.
    //
    // vitest's own breakdown named the problem: `environment 290.94s` against
    // `tests 19.11s`. The suite spends almost none of its time testing - it
    // spends it CONSTRUCTING A DOM, once per test file, 264 times over. On a
    // many-core laptop that hides behind parallelism and the whole run takes
    // about seventeen seconds. The CI runner has TWO cores and cannot hide it,
    // so that number IS the wall time: the unit job took 295 seconds and billed
    // six minutes, on every push to every open pull request - roughly 96 billed
    // minutes an hour, the largest single line on a $315 Actions week.
    //
    // happy-dom is the same API and about half the construction cost. Measured
    // here, same machine, same suite: environment 170.68s -> 85.39s, wall
    // 11.45s -> 7.58s, with all 3,258 tests passing.
    //
    // Per-file environments were tried first and abandoned: switching the
    // default to `node` and opting in only where a DOM is used broke 180 of 259
    // files, because the SOURCE they import touches `window` transitively. That
    // is a fix in src/, not in the tests, and it is not worth it now.
    environment: 'happy-dom',
    // Each hosted job owns its VM. Honor its requested width without claiming
    // more CPUs than the process can actually use; local uncapped runs remain
    // unchanged. Vitest 4 reads this top-level option, not poolOptions.
    maxWorkers: clientVitestWorkerBudget({
      requested: process.env.VITEST_MAX_THREADS,
      ci: Boolean(process.env.CI),
      availableCpus: availableParallelism(),
    }),
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    exclude: ['node_modules', 'dist', 'e2e', 'tests/_archive/**'],
    setupFiles: ['tests/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.d.ts', 'src/**/*.test.{ts,tsx}', 'src/vite-env.d.ts'],
    },
  },
  resolve: {
    alias: {
      '@arena-display': path.resolve(__dirname, './src/lib/arenaDisplay'),
      // Server-only dep — stubbed so client suites can import server services
      // See tests/stubs/canvas-confetti.ts — the real library's rAF loop
      // outlives jsdom's canvas and fails the whole run, which blocks the
      // bundle publish. The import is dynamic, so only an alias catches it.
      'canvas-confetti': path.resolve(__dirname, './tests/stubs/canvas-confetti.ts'),
      '@': path.resolve(__dirname, './src'),
      '@components': path.resolve(__dirname, './src/components'),
      '@lib': path.resolve(__dirname, './src/lib'),
      '@hooks': path.resolve(__dirname, './src/hooks'),
      '@stores': path.resolve(__dirname, './src/stores'),
      '@types': path.resolve(__dirname, './src/types'),
      '@services': path.resolve(__dirname, './src/services'),
    },
  },
});
