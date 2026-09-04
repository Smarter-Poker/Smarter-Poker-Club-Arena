import { defineConfig } from 'vitest/config';
import { cpus } from 'node:os';
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
    // WHAT THE CAP ACTUALLY COSTS. The first version of this comment recorded
    // 33.2s uncapped against 37s at maxThreads=2, and concluded the suite was
    // dominated by fixed per-file cost rather than parallel width. That was
    // wrong, and it was wrong because THE CAP WAS NEVER APPLIED: it was set as
    // `poolOptions.threads.maxThreads`, which Vitest 4 removed, so both columns
    // were the same uncapped run and the four-second delta was noise. vitest
    // had been printing a DEPRECATED notice about it on every run.
    //
    // Re-measured with the option vitest actually reads (tests/components,
    // 28-core machine, CI=1):
    //
    //     maxWorkers=2    16s
    //     maxWorkers=4    10s
    //     maxWorkers=28   11s
    //
    // So width DOES matter up to about four, and buys nothing past it. Two is
    // 60 percent slower than four, not 10 percent - worth knowing before
    // anyone "tightens" this again to relieve contention.
    //
    // Local runs stay uncapped anyway, so `npm test` on a laptop is unchanged.
    // Vitest 4 REMOVED `poolOptions`; the equivalent is top-level `maxWorkers`.
    // This was written as `poolOptions.threads.maxThreads`, so it was ignored
    // from the day it landed - vitest printed a DEPRECATED notice and ran the
    // suite at full width anyway. The measurement recorded above (33.2s
    // uncapped vs 37s "capped") was uncapped in BOTH columns, which is exactly
    // why the two numbers were nearly identical; the conclusion drawn from it,
    // that the suite is dominated by fixed per-file cost rather than parallel
    // width, was never actually tested.
    //
    // Sized from the box: cores/4 leaves room for roughly four heavy jobs
    // sharing a runner, which is what one pull request puts there.
    maxWorkers: process.env.VITEST_MAX_THREADS
      ? Number(process.env.VITEST_MAX_THREADS)
      : process.env.CI
        ? Math.max(2, Math.floor(cpus().length / 4))
        : undefined,
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
