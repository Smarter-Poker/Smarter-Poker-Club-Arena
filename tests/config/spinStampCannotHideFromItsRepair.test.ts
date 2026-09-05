/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A LOST SPIN STAMP CANNOT HIDE FROM THE THING THAT REPAIRS IT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 2026-09-05. Four spins completed on 2026-09-01 carrying `spin_multiplier`
 * NULL, and stayed that way for four days with three separate recovery
 * mechanisms pointed at them. The chain, because each link reads as a sensible
 * decision on its own:
 *
 *   1. They drew. `spin_reserve_ledger` holds a jackpot_draw row for each at
 *      20:45:58..20:46:34 booking 2x, 2x, 3x, 3x. The money moved.
 *   2. Every write the engine then made to `tournaments` was lost - the whole
 *      patch, and `started_at` with it. Seventeen sibling spins created in the
 *      same twenty minutes also lost `started_at`, so it was that engine in
 *      that window, not anything about spins.
 *   3. `scheduleSpinRowRepair` is the engine's own retry and it lives in
 *      PROCESS MEMORY for about a minute. The engine restarts at :55 of every
 *      hour (CLAUDE.md 13). These drew at :46.
 *   4. The backstop its own comment names - fn_spin_repair_missing_multiplier
 *      - gated on `started_at IS NOT NULL`. A spin whose writes were lost has
 *      no start. The documented last resort was unreachable for precisely the
 *      rows that reached it, and fn_spin_sweep_unbooked carried the identical
 *      blindness one function over (`t.started_at > now() - interval`, and
 *      NULL > anything is NULL, which is not true).
 *
 * These pins are on the DB functions as the LATEST migration defines them, in
 * the style of satelliteDoubleQualification.guard.ts - so a future migration
 * that reintroduces the gate fails here rather than in production four days
 * later.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS = join(__dirname, '..', '..', 'supabase', 'migrations');

/** SQL comments are prose. A rule cannot be enforced by a sentence about it. */
const codeOnly = (sql: string) => sql.replace(/--[^\n]*/g, '');

function latestDefinitionOf(fnName: string): string {
  const owning = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .filter((f) => readFileSync(join(MIGRATIONS, f), 'utf8').includes(`FUNCTION public.${fnName}`));
  expect(owning.length, `no migration defines ${fnName}`).toBeGreaterThan(0);
  return codeOnly(readFileSync(join(MIGRATIONS, owning[owning.length - 1]), 'utf8'));
}

describe('neither spin recovery path is blind to a spin that never started', () => {
  it('the repair does not gate on a bare started_at', () => {
    const sql = latestDefinitionOf('fn_spin_repair_missing_multiplier');
    // The exact clause that hid four spins for four days.
    expect(sql).not.toMatch(/AND\s+t\.started_at\s+IS\s+NOT\s+NULL/i);
    expect(sql).toMatch(/COALESCE\(t\.started_at,\s*t\.created_at\)/i);
  });

  it('the sweep does not compare a bare started_at against the window', () => {
    // `NULL > now() - interval` is NULL, not false and not true - so the row
    // is skipped by a comparison that reads as a date filter.
    const sql = latestDefinitionOf('fn_spin_sweep_unbooked');
    expect(sql).not.toMatch(/AND\s+t\.started_at\s*>\s*now\(\)/i);
    expect(sql).toMatch(/COALESCE\(t\.started_at,\s*t\.created_at\)\s*>\s*now\(\)/i);
  });

  it('a booked draw with no stamp is repaired at ANY age', () => {
    // The repair runs on a quarter-hour cron with a 240-minute lookback, and
    // those four finished fourteen minutes inside it. An engine back an hour
    // later would have aged
    // them out permanently, leaving only a human. A spin that HAS a
    // jackpot_draw and NO multiplier is broken by definition, so the window
    // must not bound it. The set is self-draining.
    const sql = latestDefinitionOf('fn_spin_repair_missing_multiplier');
    expect(sql).toMatch(/OR\s+d\.multiplier\s+IS\s+NOT\s+NULL/i);
  });

  it('the repair believes the ledger before it believes the prize pool', () => {
    // prize_pool / buy_in equals the drawn multiplier only once the draw has
    // been applied to the pool. On a spin that lost its stamp it has not been:
    // the pool is still the sum of the three buy-ins, so the ratio reads 3.0
    // on every three-handed spin whatever was drawn. It would have stamped
    // 3,3,3,3 where the ledger says 3,3,2,2.
    const sql = latestDefinitionOf('fn_spin_repair_missing_multiplier');
    const witnessAt = sql.indexOf('spin_reserve_ledger.jackpot_draw');
    const ratioAt = sql.indexOf('prize_pool / buy_in_amount');
    expect(witnessAt, 'the ledger witness branch is missing').toBeGreaterThan(-1);
    expect(ratioAt, 'the ratio fallback is missing').toBeGreaterThan(-1);
    expect(witnessAt, 'the ratio must be the FALLBACK, not the first answer').toBeLessThan(ratioAt);
  });

  it('a guarded UPDATE that matched nothing is not counted as a repair', () => {
    /* Found by the final sweep over this session's own work. The repair did
       `UPDATE ... WHERE id = x AND COALESCE(spin_multiplier,0) <= 0` and then
       incremented its counter unconditionally, so a row stamped by another
       pass between the SELECT and the UPDATE was reported as repaired AND got
       a financial_alerts row describing work that never happened.

       Reachable by design: two pg_cron jobs drive this function under
       DIFFERENT advisory locks. And it is the same shape as the engine bug
       this file exists for - written again, in SQL, hours after fixing it in
       TypeScript. */
    const sql = latestDefinitionOf('fn_spin_repair_missing_multiplier');
    expect(sql).toMatch(/GET\s+DIAGNOSTICS\s+v_hit\s*=\s*ROW_COUNT/i);
    expect(sql).toMatch(/IF\s+v_hit\s*=\s*0\s+THEN/i);
    // and the miss is reported rather than silently dropped
    expect(sql).toContain("'lost_the_race'");
  });

  it('the sweep reports no field it does not compute', () => {
    // `skipped_no_entrants` was declared, never incremented, and returned - a
    // permanent 0 an operator could mistake for a measurement.
    const sql = latestDefinitionOf('fn_spin_sweep_unbooked');
    expect(sql).not.toContain('skipped_no_entrants');
    expect(sql).not.toMatch(/v_skipped/);
  });

  it('the repair never claws a paid prize back', () => {
    // CLAUDE.md 10.9 rule 3: overpay caused by our own defect is absorbed by
    // the house, reported, and left alone.
    const sql = latestDefinitionOf('fn_spin_repair_missing_multiplier');
    expect(sql).toMatch(/'clawed_back',\s*false/);
    expect(sql).not.toMatch(/UPDATE\s+public\.wallet_transactions/i);
  });
});
