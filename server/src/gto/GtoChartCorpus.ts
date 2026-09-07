import type { GtoChartRow } from '../engine/GtoCharts.js';
import { assertValidChartPolicyRow } from './SolverPolicyArtifactLoader.js';

const EXPECTED_DEPTHS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 25];
const EXPECTED_OPEN_POSITIONS = ['UTG', 'MP', 'CO', 'BTN', 'SB'];

function identity(row: GtoChartRow): string {
  return `${row.game_type}|${row.villain_action}|${row.hero_position}|${row.stack_depth}`;
}

export function expectedGtoChartCorpusKeys(): Set<string> {
  const keys = new Set<string>();
  for (const game of ['Cash', 'Tournament']) {
    for (const depth of EXPECTED_DEPTHS) {
      for (const position of EXPECTED_OPEN_POSITIONS) {
        keys.add(`${game}|fold_to_hero|${position}|${depth}`);
      }
      keys.add(`${game}|sb_push|BB|${depth}`);
    }
  }
  return keys;
}

/** A partial successful query must never replace the known-good 240-row corpus. */
export function assertCompleteGtoChartCorpus(rows: GtoChartRow[]): number {
  if (!Array.isArray(rows)) throw new Error('invalid_gto_chart_corpus');
  const expected = expectedGtoChartCorpusKeys();
  const actual = new Set<string>();
  for (const row of rows) {
    assertValidChartPolicyRow(row);
    const key = identity(row);
    if (actual.has(key)) throw new Error(`duplicate_gto_chart_row:${key}`);
    if (!expected.has(key)) throw new Error(`unexpected_gto_chart_row:${key}`);
    actual.add(key);
  }
  const missing = [...expected].filter((key) => !actual.has(key));
  if (missing.length > 0 || actual.size !== expected.size) {
    throw new Error(
      `incomplete_gto_chart_corpus:expected=${expected.size}:actual=${actual.size}:missing=${missing[0] || 'unknown'}`
    );
  }
  return actual.size;
}
