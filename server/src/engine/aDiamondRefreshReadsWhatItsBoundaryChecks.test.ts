/**
 * A DIAMOND TABLE'S REFRESH READS EVERY COLUMN ITS BOUNDARY CHECKS (2026-10-09).
 *
 * refreshRakeConfig re-reads the table row and asks assertDiamondTable whether
 * the arena may keep dealing under it. The boundary judges game_variant,
 * status, the blinds and bbj_percent, and the re-read asked for none of them,
 * so every refresh of every live Diamond cash table was refused ("Diamond Plain
 * Cash Table Required", about 800 lines in six hours on 2026-10-09) and a
 * permitted change never landed until the next restart.
 * aDiamondTableKeepsItsBoundaryWhileItRuns could not see it: its mock returns
 * a whole row whatever the select asked for.
 *
 * The column list is taken from the boundary's own source, so a check added
 * there that this read does not carry fails here.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const maybeSingle = vi.fn();
const selectSpy = vi.fn();

vi.mock('../services/supabase/client.js', () => {
  const from = (table: string) => ({
    select: (cols: string) => {
      selectSpy(table, cols);
      return { eq: () => ({ maybeSingle }) };
    },
  });
  return { supabase: { from }, maintenanceSupabase: { from } };
});
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));

const { ServerTableEngine } = await import('./ServerTableEngine.js');

const boundarySrc = readFileSync(
  fileURLToPath(new URL('../domain/DiamondCashBoundary.ts', import.meta.url)),
  'utf8'
);

/** Every column assertDiamondCashTable / assertDiamondTable reads off the row. */
function cashBoundaryColumns(): string[] {
  const start = boundarySrc.indexOf('export function assertDiamondCashTable(');
  const end = boundarySrc.indexOf('\n}\n', start);
  const body = boundarySrc.slice(start, end);
  const cols = new Set<string>();
  for (const m of body.matchAll(/\btable\.([a-z_]+)/g)) cols.add(m[1]);
  for (const arr of body.matchAll(/=\s*\[([^\]]*)\]/g)) {
    for (const lit of arr[1].matchAll(/'([a-z_]+)'/g)) cols.add(lit[1]);
  }
  for (const loop of body.matchAll(/for \(const key of \[([^\]]*)\]\)/g)) {
    for (const lit of loop[1].matchAll(/'([a-z_]+)'/g)) cols.add(lit[1]);
  }
  // assertDiamondTable chooses the boundary from these two.
  cols.add('tournament_id');
  cols.add('game_type');
  // Status values, not columns.
  for (const v of ['waiting', 'running', 'playing', 'active']) cols.delete(v);
  return [...cols].sort();
}

beforeEach(() => {
  maybeSingle.mockReset();
  selectSpy.mockReset();
  maybeSingle.mockResolvedValue({ data: null });
});
afterEach(() => vi.restoreAllMocks());

describe('a Diamond refresh reads what its boundary checks', () => {
  it('finds the boundary columns in the boundary source', () => {
    const cols = cashBoundaryColumns();
    for (const c of [
      'game_variant',
      'status',
      'small_blind',
      'big_blind',
      'bbj_percent',
      'rake_percent',
    ])
      expect(cols).toContain(c);
  });

  it('asks the database for every one of them', async () => {
    const e = new ServerTableEngine('dddddddd-3333-4444-8888-dddddddddddd') as any;
    e.tableInfo = {
      id: e.tableId,
      club_id: 'arena',
      game_type: 'cash',
      arena: { id: 'arena', asset: 'diamonds', is_platform: true, union_id: null },
    };
    e.lastRakeRefreshAtMs = 0;
    await e.refreshRakeConfig(true);
    e.preciseTimer?.dispose?.();

    const ruleSelect = selectSpy.mock.calls.find(
      (c) => c[0] === 'tables' && String(c[1]).includes('rake_percent')
    );
    expect(ruleSelect, 'the rule row is read').toBeTruthy();
    const read = String(ruleSelect![1])
      .split(/,\s*/)
      .map((s) => s.trim());
    const missing = cashBoundaryColumns().filter((c) => !read.includes(c));
    expect(missing, 'columns the Diamond boundary checks that the refresh never reads').toEqual([]);
  });
});
