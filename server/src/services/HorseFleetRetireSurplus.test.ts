/**
 * The fleet spawns and retires nothing. (Gate 7, 2026-09-05)
 *
 * HISTORY, so the shape of the old bug is not forgotten: spawnOverflowTables()
 * capped creation at MAX_TABLES_PER_CONFIG and left a comment saying "the
 * stale-table lifecycle owns closing". No such lifecycle existed, so when
 * ensureAllTablesExist() began duplicating rows on every boot the count only
 * went one way: 121 rows named 'NLH 1.00/2.00', 495 fleet tables in all.
 * retireSurplusTables() was written on 2026-08-19 to drain it back down, and
 * this file used to pin the two halves that made the pair converge.
 *
 * MOVED 2026-09-05 for Gate 7 (Operation Table Stakes). OPORD 1.4 s2.11 forbids
 * every one of those mechanisms for ever: a cash table is opened and closed
 * ONLY by the cluster controller (fn_cash_cluster_tick); the cap is
 * cash_games.cap_mains; there are no '#2 / #3' clones and no
 * MAX_TABLES_PER_CONFIG. The database refuses a cash table with no game behind
 * it (tables_cash_needs_a_game). So the pin is inverted: the fleet must never
 * grow a table writer again, and closing must be the tick's BREAK rule. The
 * controller's own wiring is pinned in
 * src/cluster/TheTablesOpenAndCloseThemselves.law.test.ts.
 *
 * What SURVIVES from the old file is the one piece that was never a writer: a
 * non-cluster table draining under a Stable Hand flag is not seeded.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(process.cwd(), 'src/services/HorseFleetManager.ts'), 'utf8');
const ROOT = join(process.cwd(), '..');
const TICK = readFileSync(
  join(
    ROOT,
    'supabase/migrations/20260905060000_the_must_move_lobby_a_seat_change_and_the_order_you_joined.sql'
  ),
  'utf8'
);
const GATE7 = readFileSync(
  join(ROOT, 'supabase/migrations/20260905034937_gate_7_every_cash_table_is_a_game.sql'),
  'utf8'
);

/** Only CODE counts: the fleet explains its history in prose and names the dead methods there. */
const CODE = SRC.split('\n')
  .filter((l) => {
    const t = l.trimStart();
    return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
  })
  .join('\n');

describe('the fleet spawns and retires nothing (Gate 7)', () => {
  it('has no retirement sweep, no overflow spawn and no per-config cap', () => {
    expect(SRC).not.toMatch(/private async retireSurplusTables/);
    expect(SRC).not.toMatch(/private async spawnOverflowTables/);
    expect(SRC).not.toMatch(/^const MAX_TABLES_PER_CONFIG\b/m);
    expect(SRC).not.toContain('await this.retireSurplusTables(');
    expect(SRC).not.toContain('await this.spawnOverflowTables(');
  });

  it('never inserts a tables row and never closes one', () => {
    expect(SRC).not.toMatch(/\.from\(['"]tables['"]\)\s*\.insert\(/);
    // Marking a table 'running' when a second seat fills is still the fleet's;
    // marking one 'closed' never is.
    expect(SRC).not.toContain("status: 'closed'");
    expect(SRC).not.toMatch(/\.update\(\{[^}]*status:\s*'closed'/);
  });

  it("builds no '#2 / #3' clone name", () => {
    expect(CODE).not.toMatch(/\$\{config\.name\} #/);
    expect(CODE).not.toMatch(/name\.startsWith\(`\$\{config\.name\} #`\)/);
  });

  it('the only table-shaped thing it can ask for is a GAME, through the controller door', () => {
    expect(SRC).toMatch(/supabase\.rpc\('fn_cash_game_ensure'/);
  });

  it('the controller law that replaced this file exists', () => {
    expect(
      existsSync(join(process.cwd(), 'src/cluster/TheTablesOpenAndCloseThemselves.law.test.ts'))
    ).toBe(true);
    expect(readFileSync(join(process.cwd(), 'src/cluster/ClusterController.ts'), 'utf8')).toContain(
      'fn_cash_cluster_tick'
    );
  });
});

describe('closing is the tick BREAK rule, in SQL, and the database refuses a table with no game', () => {
  it('the tick closes a broken table and records table_break_completed', () => {
    const tick = TICK.slice(TICK.indexOf('CREATE OR REPLACE FUNCTION public.fn_cash_cluster_tick'));
    const close = tick.indexOf("UPDATE public.tables SET status = 'closed', lifecycle = 'closed'");
    const event = tick.indexOf("'table_break_completed'");
    expect(close).toBeGreaterThan(0);
    expect(event).toBeGreaterThan(close);
  });

  it('a cash table with no game behind it is refused by a CHECK, not by a sweep', () => {
    expect(GATE7).toMatch(/ADD CONSTRAINT tables_cash_needs_a_game/);
  });
});

describe('what survives: a draining non-cluster table is not seeded', () => {
  it('surplus tables are skipped by the seeding loop', () => {
    expect(SRC).toContain('if (surplusTableIds.has(table.id)) continue;');
  });

  it('a cluster table is never surplus, whatever flag it carries', () => {
    expect(SRC).toMatch(/if \(t\.cluster_id\) continue;\s*if \(isRetiringTable\(t/);
  });

  it('selects created_at, so the cluster ordering the fleet seeds in is defined', () => {
    expect(SRC).toContain('current_players, created_at');
  });
});
