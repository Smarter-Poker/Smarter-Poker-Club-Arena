/**
 * ensureAllTablesExist() cannot duplicate a table, because it creates none.
 *
 * HISTORY: it did, on every boot, for months. The existence check was
 *
 *   const { data: existing } = await supabase.from('tables')...maybeSingle();
 *
 * PostgREST answers .maybeSingle() with PGRST116 when MORE THAN ONE row
 * matches. The error was destructured away, so `existing` was null, so the
 * code inserted another row, which guaranteed the next boot would do it again.
 * Production held 120 'NLH 1.00/2.00', 120 'NLH 2.00/5.00', 83 PLO4, 83 PLO5
 * and 81 PLO6 rows. The 2026-08-19 fix was `.limit(1)` with the error checked,
 * and this file drove a fake client through both lookups to prove it.
 *
 * MOVED 2026-09-05 for Gate 7 (Operation Table Stakes). The lookup and the
 * insert are both gone: every DEFAULT_TABLES key is a `cash_games` row, the
 * ClusterController keeps each game's Main 1 open (R3) and reopens a closed
 * one on every tick (RECONCILE), and the database refuses a cash table with no
 * game behind it (tables_cash_needs_a_game). A duplicate is impossible by
 * construction rather than avoided by a careful query, so the pin becomes:
 * the method touches no `tables` row, and the fleet has no table insert.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(process.cwd(), 'src/services/HorseFleetManager.ts'), 'utf8');
const ROOT = join(process.cwd(), '..');
const GATE7 = readFileSync(
  join(ROOT, 'supabase/migrations/20260905034937_gate_7_every_cash_table_is_a_game.sql'),
  'utf8'
);
const SLICE2 = readFileSync(
  join(ROOT, 'supabase/migrations/20260905010500_cluster_controller_slice_2.sql'),
  'utf8'
);

/** The method body, from its signature to the next private method. */
function ensureAllTablesExistBody(): string {
  const start = SRC.indexOf('private async ensureAllTablesExist(');
  expect(start).toBeGreaterThan(0);
  const rest = SRC.slice(start + 1);
  const next = rest.search(/\n {2}private async /);
  return rest.slice(0, next);
}

describe('ensureAllTablesExist creates nothing, so it can duplicate nothing (Gate 7)', () => {
  it('is still called at boot: the seat-law check it carries must keep running', () => {
    expect(SRC).toContain('await this.ensureAllTablesExist();');
    expect(ensureAllTablesExistBody()).toContain("'HorseFleet.seat_law_override'");
  });

  it('reads no tables row, inserts none and updates none', () => {
    const body = ensureAllTablesExistBody();
    expect(body).not.toMatch(/\.from\(['"]tables['"]\)/);
    expect(body).not.toContain('.insert(');
    expect(body).not.toContain('.update(');
    expect(body).not.toContain('maybeSingle(');
  });

  it('the whole fleet has no table insert, so no boot can add a row', () => {
    expect(SRC).not.toMatch(/\.from\(['"]tables['"]\)\s*\.insert\(/);
  });

  it('the database refuses a cash table with no game (the duplicate is impossible, not avoided)', () => {
    expect(GATE7).toMatch(/ADD CONSTRAINT tables_cash_needs_a_game/);
  });

  it('the controller keeps Main 1 open itself (R3), which is what the boot insert used to be for', () => {
    expect(SLICE2).toMatch(/IF g\.enabled AND \(v_main1\.id IS NULL OR v_main1\.status NOT IN/);
  });
});
