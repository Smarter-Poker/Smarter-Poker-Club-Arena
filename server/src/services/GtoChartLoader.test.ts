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

afterEach(() => {
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

  it('cancels both boot and refresh timers during graceful shutdown', () => {
    vi.useFakeTimers();
    startGtoChartLoader();
    expect(vi.getTimerCount()).toBe(2);
    stopGtoChartLoader();
    expect(vi.getTimerCount()).toBe(0);
  });
});
