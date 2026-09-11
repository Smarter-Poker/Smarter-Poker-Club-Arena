import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GtoChartRow } from '../engine/GtoCharts.js';
import { assertCompleteGtoChartCorpus, expectedGtoChartCorpusKeys } from '../gto/GtoChartCorpus.js';
import {
  _clearSolverPolicyArtifactsForTests,
  hydrateChartPolicyArtifact,
  recordChartPolicyRefreshError,
  solverPolicyArtifactStatus,
} from '../gto/SolverPolicyArtifactLoader.js';
import { startGtoChartLoader, stopGtoChartLoader } from './GtoChartLoader.js';
import {
  assertCompleteGtoPostflopSnapshot,
  startGtoPostflopLoader,
  stopGtoPostflopLoader,
} from './GtoPostflopLoader.js';
import { startGtoPostflopV31Loader, stopGtoPostflopV31Loader } from './GtoPostflopV31Loader.js';

afterEach(() => {
  stopGtoPostflopV31Loader();
  stopGtoPostflopLoader();
  stopGtoChartLoader();
  vi.useRealTimers();
});

const DEPTHS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 25];

function completeCorpus(): GtoChartRow[] {
  const rows: GtoChartRow[] = [];
  for (const game_type of ['Cash', 'Tournament']) {
    for (const stack_depth of DEPTHS) {
      for (const hero_position of ['UTG', 'MP', 'CO', 'BTN', 'SB']) {
        rows.push({
          chart_id: `${game_type}-${hero_position}-${stack_depth}`,
          game_type,
          stack_depth,
          hero_position,
          villain_action: 'fold_to_hero',
          hand_matrix: { AA: { push: 1, fold: 0 } },
        });
      }
      rows.push({
        chart_id: `${game_type}-BB-${stack_depth}`,
        game_type,
        stack_depth,
        hero_position: 'BB',
        villain_action: 'sb_push',
        hand_matrix: { AA: { call: 1, fold: 0 } },
      });
    }
  }
  return rows;
}

describe('GTO chart corpus refresh guard', () => {
  it('refuses a shifted or uncounted legacy postflop snapshot', () => {
    const stable = { count: 7_747, latestBuiltAt: '2026-09-01T00:00:00.000Z' };
    expect(() => assertCompleteGtoPostflopSnapshot(stable, 7_747, stable)).not.toThrow();
    expect(() =>
      assertCompleteGtoPostflopSnapshot({ ...stable, count: null }, 7_747, stable)
    ).toThrow(/exact_count_unavailable/);
    expect(() => assertCompleteGtoPostflopSnapshot(stable, 7_500, stable)).toThrow(
      /snapshot_shifted/
    );
    expect(() =>
      assertCompleteGtoPostflopSnapshot(stable, 7_747, { ...stable, count: 7_748 })
    ).toThrow(/snapshot_shifted/);
    expect(() =>
      assertCompleteGtoPostflopSnapshot(stable, 7_747, {
        ...stable,
        latestBuiltAt: '2026-09-01T00:00:01.000Z',
      })
    ).toThrow(/snapshot_shifted/);
  });

  it('requires the exact 240-row game, node, position, and depth lattice', () => {
    const rows = completeCorpus();
    expect(expectedGtoChartCorpusKeys().size).toBe(240);
    expect(rows).toHaveLength(240);
    expect(assertCompleteGtoChartCorpus(rows)).toBe(240);
  });

  it('rejects partial, duplicate, and unexpected successful query results', () => {
    const rows = completeCorpus();
    expect(() => assertCompleteGtoChartCorpus(rows.slice(0, -1))).toThrow(
      /incomplete_gto_chart_corpus/
    );
    expect(() => assertCompleteGtoChartCorpus([...rows, rows[0]])).toThrow(
      /duplicate_gto_chart_row/
    );
    const unexpected = structuredClone(rows);
    unexpected[0].hero_position = 'HJ';
    expect(() => assertCompleteGtoChartCorpus(unexpected)).toThrow(/invalid_chart_policy_identity/);
  });

  it('keeps the last-good policies and makes a pre-hydration corpus failure visible', () => {
    _clearSolverPolicyArtifactsForTests();
    const seed = completeCorpus()[0];
    expect(hydrateChartPolicyArtifact([seed])).toBe(1);
    const error = new Error('incomplete_gto_chart_corpus:expected=240:actual=239');
    recordChartPolicyRefreshError(error);
    expect(solverPolicyArtifactStatus().charts).toMatchObject({
      count: 1,
      lastError: error.message,
    });
    const loaderSource = readFileSync(
      fileURLToPath(new URL('./GtoChartLoader.ts', import.meta.url)),
      'utf8'
    );
    expect(loaderSource).toContain('recordChartPolicyRefreshError(err)');
    _clearSolverPolicyArtifactsForTests();
  });

  it('arms one idempotent periodic timer per store and cancels all of them at shutdown', () => {
    vi.useFakeTimers();
    startGtoChartLoader();
    startGtoPostflopLoader();
    startGtoPostflopV31Loader();
    expect(vi.getTimerCount()).toBe(3);

    startGtoChartLoader();
    startGtoPostflopLoader();
    startGtoPostflopV31Loader();
    expect(vi.getTimerCount()).toBe(3);

    stopGtoPostflopV31Loader();
    stopGtoPostflopLoader();
    stopGtoChartLoader();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('loads each live store exactly once before arming its failure-adaptive refresh', () => {
    const workerSource = readFileSync(
      fileURLToPath(new URL('../engine/horseDecision/localServices.ts', import.meta.url)),
      'utf8'
    );
    const bindings = readFileSync(
      new URL('../engine/horseDecision/localDependencies.ts', import.meta.url),
      'utf8'
    );
    const stores = [
      {
        load: 'loadGtoCharts',
        localLoad: 'loadCharts',
        start: 'startGtoChartLoader',
        localStart: 'startChartLoader',
        source: './GtoChartLoader.ts',
      },
      {
        load: 'loadGtoPostflop',
        localLoad: 'loadPostflop',
        start: 'startGtoPostflopLoader',
        localStart: 'startPostflopLoader',
        source: './GtoPostflopLoader.ts',
      },
      {
        load: 'loadGtoPostflopV31',
        localLoad: 'loadPostflopV31',
        start: 'startGtoPostflopV31Loader',
        localStart: 'startPostflopV31Loader',
        source: './GtoPostflopV31Loader.ts',
      },
    ] as const;

    for (const store of stores) {
      const loaderSource = readFileSync(
        fileURLToPath(new URL(store.source, import.meta.url)),
        'utf8'
      );
      const loadCalls =
        workerSource.match(new RegExp(`services\\.${store.localLoad}\\(\\)`, 'g')) ?? [];
      const startCalls =
        workerSource.match(new RegExp(`services\\.${store.localStart}\\(\\)`, 'g')) ?? [];

      expect(bindings).toContain(`${store.localLoad}: ${store.load}`);
      expect(bindings).toContain(`${store.localStart}: ${store.start}`);
      expect(loadCalls, `${store.load} must have one authoritative boot read`).toHaveLength(1);
      expect(startCalls, `${store.start} must arm one refresh owner`).toHaveLength(1);
      expect(workerSource.indexOf(`services.${store.localLoad}()`)).toBeLessThan(
        workerSource.indexOf(`services.${store.localStart}()`)
      );
      expect(loaderSource).toContain('createAdaptiveRefreshLoop({');
      expect(loaderSource).toContain('retryMs: RETRY_MS');
      expect(loaderSource).toContain('maxRetryMs: MAX_RETRY_MS');
      expect(loaderSource).not.toContain('setTimeout(');
      expect(loaderSource).not.toContain('BOOT_DELAY_MS');
      expect(loaderSource).not.toContain('setInterval(');
    }
  });
});
