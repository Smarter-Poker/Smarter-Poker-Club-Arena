/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  A SPIN THAT RAN WITHOUT A DRAW — and could never be repaired
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * On 2026-08-21, three Spins reached COMPLETED with `spin_multiplier = NULL`:
 *
 *   dea62e98  1 Chip Spin PLO4    a374cdd3  2 Chip Spin NLH
 *   78181713  3 Chip Spin NLH
 *
 * All three carry the marks of a start that never entered the Spin block in
 * TournamentManagerBase: `prize_pool` still the value registration accumulated
 * one buy-in at a time (3.00 / 6.00 / 9.00 — seats x buy-in, stored with the
 * two decimals a numeric keeps, where a drawn pool is written by the engine
 * and stores as 3 / 6 / 9), the creation-time placeholder stack, and no
 * `spin_reserve_ledger` or `rake_records` row at all. 69 of the other 72 Spins
 * that hour drew normally and none has failed in the 28 hours since, so the
 * cause was transient — engine version skew across a restart.
 *
 * The DURABLE defect was that nothing could ever repair them:
 * `fn_spin_sweep_unbooked` filtered `COALESCE(spin_multiplier, 0) > 0`, so it
 * skipped precisely the rows that needed it, and `unbooked_24h` aged them out
 * after a day. The house never took its rake and the reserve never saw the
 * money, silently and permanently.
 *
 * Two things are pinned here:
 *
 *   1. The repair reconstructs the multiplier from the money that actually
 *      moved — prize_pool / buy_in_amount — and accepts it ONLY when it lands
 *      exactly on a published tier. Anything else raises a critical alert and
 *      is left alone, because inventing a multiplier writes fiction into the
 *      money ledger.
 *
 *   2. The tier list inside the SQL matches SPIN_TIERS. Drift between copies
 *      of the tier table is exactly how three conflicting multiplier tables
 *      happened before 2026-08-20; this makes it a test failure instead.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SPIN_TIERS } from '../../server/src/config/spinSpec';
import { sliceBlockAfter } from '../helpers/sourceWindow';

const read = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf8');
const sqlCode = (src: string) => src.replace(/^[ \t]*--.*$/gm, '');
const tsCode = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const MIGRATION = 'supabase/migrations/20260822191000_spin_null_multiplier_repair.sql';
const migration = sqlCode(read(MIGRATION));

describe('fn_spin_repair_missing_multiplier', () => {
  it('carries the same tier ladder as SPIN_TIERS', () => {
    const m = migration.match(/v_tiers\s+numeric\[\]\s*:=\s*ARRAY\[([^\]]+)\]/);
    expect(m, 'the repair must declare its tier ladder').not.toBeNull();
    const inSql = m![1].split(',').map((s) => Number(s.trim()));
    expect(inSql).toEqual(SPIN_TIERS.map((t) => t.multiplier));
  });

  it('reconstructs from the prize actually paid, not from a fresh roll', () => {
    // A re-draw here would hand out a multiplier the players never played for
    // and the reserve was never asked about.
    expect(migration).toMatch(/v_ratio\s*:=\s*round\(v_t\.prize_pool \/ v_t\.buy_in_amount, 4\)/);
    expect(migration).not.toMatch(/random\(\)/);
    expect(migration).not.toMatch(/fn_spin_draw_multiplier/);
  });

  it('only accepts a ratio that lands exactly on a tier', () => {
    expect(migration).toMatch(/IF v_ratio IS NOT NULL AND v_ratio = ANY \(v_tiers\) THEN/);
  });

  it('raises a critical alert instead of guessing when it cannot reconstruct', () => {
    expect(migration).toMatch(
      /'critical', 'fn_spin_repair_missing_multiplier'[\s\S]*?cannot be reconstructed/
    );
    expect(migration).toMatch(/no multiplier was invented/);
  });

  it('never overwrites a multiplier that was really drawn', () => {
    // CAS on the update: two sweeps overlapping, or a sweep racing a late
    // engine write, must not replace a real draw with a reconstruction.
    expect(migration).toMatch(
      /UPDATE public\.tournaments[\s\S]*?WHERE id = v_t\.id\s*\n\s*AND COALESCE\(spin_multiplier, 0\) <= 0;/
    );
  });

  it('is not reachable by a player role', () => {
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_spin_repair_missing_multiplier\(integer\) FROM anon/
    );
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_spin_repair_missing_multiplier\(integer\) FROM authenticated/
    );
  });
});

describe('fn_spin_sweep_unbooked', () => {
  it('repairs before it books, so a null multiplier is no longer terminal', () => {
    const start = migration.indexOf('FUNCTION public.fn_spin_sweep_unbooked(');
    expect(start).toBeGreaterThan(-1);
    const body = migration.slice(start);
    const repair = body.indexOf('fn_spin_repair_missing_multiplier(p_lookback_mins)');
    const loop = body.indexOf('FOR v_t IN');
    expect(repair, 'the sweep must run the repair').toBeGreaterThan(-1);
    expect(repair).toBeLessThan(loop);
  });

  it('a failing repair cannot stop the sweep booking everything else', () => {
    expect(migration).toMatch(
      /v_repair := public\.fn_spin_repair_missing_multiplier\(p_lookback_mins\);\s*\n\s*EXCEPTION WHEN OTHERS THEN/
    );
  });

  it('needs no reader change — the World Hub cron calls it exactly as before', () => {
    expect(migration).toMatch(
      /FUNCTION public\.fn_spin_sweep_unbooked\(p_lookback_mins integer DEFAULT 180\)\s*\nRETURNS jsonb/
    );
  });
});

describe('v_spin_reserve_health', () => {
  it('publishes null_multiplier_24h so this can never be silent again', () => {
    expect(migration).toMatch(/AS null_multiplier_24h/);
  });

  it('still publishes every column the deployed World Hub cron selects', () => {
    // 2026-08-21: a column was dropped while a cached client still selected
    // it, the hook swallowed the error and the Spin badge went dark for real
    // users. Adding is safe; removing is that incident verbatim.
    for (const col of ['can_draw_500x', 'unbooked_24h', 'shortfall_events', 'is_thin']) {
      expect(migration, `v_spin_reserve_health must keep ${col}`).toMatch(new RegExp(`AS ${col}`));
    }
  });
});

describe('the engine no longer starts a Spin on an unchecked write', () => {
  const engine = tsCode(read('server/src/tournament/TournamentManagerBase.ts'));

  it('validates the immutable funded-rule receipt, then reads back presentation separately', () => {
    // 2026-09-10: the three-attempt loop moved into spinLaunchParking.ts so a
    // refusal can be classified; the call site hands it the RPC and the
    // receipt reader.
    const settlementLoop = sliceBlockAfter(
      engine,
      'const proven = await proveSpinDrawWithParking<FundedSpinDraw>('
    );
    expect(settlementLoop).toMatch(/supabase\.rpc\('fn_spin_draw_and_settle_atomic'/);
    expect(settlementLoop).toMatch(/const \{ data, error \}/);
    expect(settlementLoop).toMatch(/readFundedSpinDraw\(data/);

    const presentationLoop = sliceBlockAfter(
      engine,
      'for (let attempt = 1; attempt <= 3 && !spinPresentationWritten; attempt++)'
    );
    expect(presentationLoop).toMatch(/error:\s*spinPresentationErr/);
    expect(presentationLoop).toMatch(/this\.launchRowMatchesPatch/);
    expect(presentationLoop).toMatch(
      /if \(attempt === 3\)[\s\S]*Tournament\.spin_presentation_write_failed/
    );
  });

  it('stands down before cards when money or presentation cannot be proven', () => {
    for (const anchor of ['if (!proven.ok)', 'if (!spinPresentationWritten)']) {
      const standDown = sliceBlockAfter(engine, anchor);
      expect(standDown).toMatch(/this\.running = false/);
      expect(standDown).toMatch(/return;/);
      expect(standDown).not.toMatch(/dealHand|startTableEngines/);
    }
  });
});
