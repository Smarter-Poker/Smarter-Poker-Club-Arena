/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  AN ALARM THAT CANNOT RING IS NOT AN ALARM
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Chasing a -226.65 drift in the BBJ conservation check turned up something
 * much larger than the drift.
 *
 *   1. public.bbj_contributions had NEVER been analysed — last_analyze,
 *      last_autoanalyze, last_vacuum and last_autovacuum were all NULL.
 *   2. The planner therefore believed it held 2,600 rows. It holds 648,543.
 *      A 250x underestimate on a 242 MB table.
 *   3. Planned on that fiction, fn_union_treasury_selftest's duplicate scan
 *      chose a catastrophic plan and hit the statement timeout. THE TREASURY
 *      SELF-TEST COULD NOT RUN.
 *   4. Which is exactly why a -226.65 breach of a 1.00 tolerance sat
 *      unreported. The alarm was not ignored. It was unable to ring.
 *
 * One ANALYZE later the self-test completes and reports the breach.
 *
 * And it was never one table: TWELVE relations over 20 MB had never been
 * analysed, including rake_records (1 GB, estimated 8,932 rows) and
 * wallet_transactions (797 MB, estimated 14,979) — money that settlement and
 * rakeback read every day, planned on a guess every time.
 *
 * Autoanalyze never fired because there are three autovacuum workers and this
 * database holds a 72 GB table and a 10 GB one. The giants monopolise the
 * workers; everything behind them starves.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const dir = resolve(__dirname, '../../supabase/migrations');
const sql = readdirSync(dir)
  .filter((f) => f.includes('money_tables_get_their_own_autoanalyze'))
  .map((f) => readFileSync(resolve(dir, f), 'utf8'))
  .join('\n');

/** Every money table that settlement, rakeback or the jackpots read. */
const MONEY_TABLES = [
  'bbj_contributions',
  'rake_records',
  'wallet_transactions',
  'club_wallet_transactions',
  'vip_points_ledger',
  'agent_commissions',
  'rake_distribution_legs',
  'rakeback_stats_applied',
];

describe('every money table gets counted', () => {
  it('ships the migration', () => {
    expect(sql.length).toBeGreaterThan(0);
  });

  it.each(MONEY_TABLES)('sets an analyze threshold on %s', (t) => {
    expect(sql).toMatch(new RegExp(`ALTER TABLE public\\.${t} SET \\(`));
  });

  it('refuses to pass if any of them is left without one', () => {
    expect(sql).toMatch(/still have no analyze threshold/);
  });

  it('counts rows, not a percentage of a total nothing has measured', () => {
    // scale_factor 0 + a flat threshold means "after N changes". A percentage
    // of an unknown row count is how this went unnoticed for so long.
    expect(sql).toMatch(/autovacuum_analyze_scale_factor = 0\.0/);
    expect(sql).toMatch(/autovacuum_analyze_threshold = \d+/);
  });
});

describe('the cure does not become the disease', () => {
  it('throttles every table it touches', () => {
    // An unthrottled vacuum on a big table saturated disk IO the same morning
    // and took /api/health down for eight minutes.
    const delays = sql.match(/autovacuum_vacuum_cost_delay = (\d+)/g) ?? [];
    expect(delays.length).toBe(MONEY_TABLES.length);
    for (const d of delays) expect(d).toMatch(/= 2$/);
  });

  it('asserts unthrottled autovacuum has not come back anywhere', () => {
    expect(sql).toMatch(/unthrottled autovacuum is back on/);
  });

  it('leaves the three non-money giants alone, and says why', () => {
    // Handing three more giants aggressive settings on a three-worker
    // autovacuum is how the starvation happened in the first place.
    expect(sql).toMatch(/NOT COVERED HERE, DELIBERATELY/);
    expect(sql).toMatch(/solved_spots_gold/);
  });
});

describe('the finding is written down where the next person will look', () => {
  it('records the measured numbers, not a vague warning', () => {
    expect(sql).toMatch(/648,543/);
    expect(sql).toMatch(/250x/);
    expect(sql).toMatch(/-226\.65/);
  });

  it('names the mechanism: three workers, two giants', () => {
    expect(sql).toMatch(/three autovacuum workers/);
  });

  it('leaves the explanation on the table itself, not only in a migration', () => {
    expect(sql).toMatch(/COMMENT ON TABLE public\.bbj_contributions/);
  });
});
