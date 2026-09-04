import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
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
    // WORKER CAP. Added 2026-09-04 after measuring, not guessing.
    //
    // vitest defaults its thread pool to the machine's core count, which is
    // correct for a laptop that owns its CPU and catastrophic on a CI box that
    // does not. estate-ci-2 is 8 cores hosting 8 runners, so eight jobs each
    // claimed eight threads. Measured on the box: ONE default run spawned 11
    // processes and drove load to 12.05; FOUR concurrent runs spawned 41
    // processes, drove load to 41.2, pushed it into swap and made the machine
    // refuse ssh until it was hard-reset. The same 910-file suite takes 31.9
    // SECONDS on an unloaded 28-core machine and was reported by CI as a
    // 12.4-MINUTE job. That gap was never the tests; it was thrash.
    //
    // The cap is close to free. Measured on this machine, same 911-file suite,
    // all passing:
    //
    //     uncapped (28 threads)  33.2s
    //     maxThreads=4           36s
    //     maxThreads=2           37s
    //
    // Four seconds. The suite is dominated by fixed per-file environment
    // construction, not by parallel width, so handing it 28 threads buys
    // almost nothing while guaranteeing it stampedes any box it shares. Two
    // threads per job means three jobs fit inside eight cores with headroom.
    //
    // Local runs stay uncapped anyway, so `npm test` on a laptop is unchanged.
    poolOptions: {
      threads: {
        maxThreads: process.env.VITEST_MAX_THREADS
          ? Number(process.env.VITEST_MAX_THREADS)
          : process.env.CI
            ? 2
            : undefined,
      },
    },
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
      // Server-only dep — stubbed so client suites can import server services
      // (see tests/stubs/sentry-node.ts for why)
      '@sentry/node': path.resolve(__dirname, './tests/stubs/sentry-node.ts'),
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
