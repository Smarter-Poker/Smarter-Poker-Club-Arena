/**
 * A SECOND SATELLITE WIN IS NEVER WORTH ZERO — and the DB gate agrees with
 * the TS gate about what "open" means (2026-08-30 satellite audit).
 *
 * Source-pin guard in the moneyPathAudit style: every pin below is a bug that
 * shipped.
 *
 *   1. fn_award_satellite_seat refused RUNNING targets outright while
 *      isSatelliteTargetOpen (PR #1935) approved them inside late
 *      registration — so the exact case #1935 existed for still cashed out.
 *      The two gates must express the same rule.
 *
 *   2. The unique_violation dedupe returned ok=true/awarded=false and the
 *      engine logged "Seat awarded". A player who won seats in two
 *      satellites got one seat and NOTHING for the second win — four times
 *      in one week (1a6f53a4, acb14548, e3d3bd1e x2). The fn now reports
 *      held_from_this_satellite and the engine pays ticket value in cash
 *      for a cross-satellite double win, under the stable place key so a
 *      recovery re-drive still dedupes.
 *
 *   3. The prize stamp write discarded its error: every e3d3bd1e winner was
 *      recorded at prize 0 while holding a funded seat.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sliceEnclosingBlock } from '../testHelpers/sourceWindow.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MANAGER = fs.readFileSync(path.join(HERE, 'TournamentManager.ts'), 'utf8');
const MIGRATIONS = path.join(HERE, '..', '..', '..', 'supabase', 'migrations');

function latestFnDefinition(): string {
  const owning = fs
    .readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .filter((f) =>
      fs
        .readFileSync(path.join(MIGRATIONS, f), 'utf8')
        .includes('FUNCTION public.fn_award_satellite_seat')
    );
  expect(owning.length, 'no migration defines fn_award_satellite_seat').toBeGreaterThan(0);
  return fs.readFileSync(path.join(MIGRATIONS, owning[owning.length - 1]), 'utf8');
}

describe('the DB seat gate agrees with the TS seat gate', () => {
  it('the latest fn_award_satellite_seat accepts a RUNNING target in late reg', () => {
    const sql = latestFnDefinition();
    expect(sql).toMatch(/RUNNING/);
    expect(sql).toMatch(/late_reg_levels/);
    expect(sql).toMatch(/rebuy_levels/);
  });

  it('the latest fn_award_satellite_seat names who seated a deduped winner', () => {
    const sql = latestFnDefinition();
    expect(sql).toMatch(/held_from_this_satellite/);
    expect(sql).toMatch(/source_satellite_id/);
  });

  /**
   * AND THEY AGREE ABOUT WHERE "OPEN" ENDS (2026-08-31).
   *
   * The two gates agreed that a RUNNING target in late reg is open and then
   * disagreed by one level about when late reg stops, because
   * `tournaments.current_level` is a ZERO-BASED index and the DB gate closed on
   * `> v_cap` while every other reader on the platform closes on `>=`. The DB
   * gate also never read `prize_pool_finalized`, so it would seat a winner into
   * an event whose payout ladder had already been sized — inserting a
   * tournament_players row, a buy-in into the finalized prize_pool, a rake row
   * and a payout row after the fact.
   *
   * `isSatelliteTargetOpen` above is pinned at the same boundary by
   * satelliteTargetOpen.test.ts. These two pins are the same rule, once on
   * each side of the wire.
   */
  it('the latest fn_award_satellite_seat closes AT the cap, not one level past it', () => {
    const sql = latestFnDefinition();
    expect(sql).toMatch(/COALESCE\(v_t\.current_level, 0\) >= v_cap/);
    // The post-apply assertion that the off-by-one cannot come back.
    expect(sql).toMatch(/the off-by-one level guard survived the rewrite/);
  });

  it('the latest fn_award_satellite_seat refuses a finalized prize pool', () => {
    const sql = latestFnDefinition();
    expect(sql).toMatch(/prize_pool_finalized/);
    expect(sql).toMatch(/target_pool_finalized/);
  });
});

describe('a cross-satellite double win pays the ticket value', () => {
  it('the engine pays cash when the seat is held from a DIFFERENT satellite', () => {
    expect(MANAGER).toMatch(/held_from_this_satellite === false/);
    expect(MANAGER).toMatch(/Satellite seat already held - ticket value paid in cash/);
  });

  it('the cash lands under the stable place key, so a re-drive dedupes', () => {
    const block = sliceEnclosingBlock(MANAGER, 'held_from_this_satellite === false');
    expect(block).toMatch(/prize:place:\$\{w\.position\}/);
  });

  it('a genuine re-drive of the same satellite still pays nothing extra', () => {
    // The branch requires the flag to be EXPLICITLY false; an old fn without
    // the flag (undefined) and a same-satellite re-drive (true) both fall
    // through to the silent path.
    expect(MANAGER).not.toMatch(/held_from_this_satellite !== true/);
  });
});

describe('the gate is given the columns it decides on', () => {
  /**
   * A gate that reads a column the query never selected returns `undefined`,
   * which is falsy, which silently means "not finalized" — the exact bug the
   * finalized check exists to close. The select list and the gate have to move
   * together.
   */
  it('the satellite target read fetches prize_pool_finalized and the level fields', () => {
    const selectList = MANAGER.match(/'id, name, buy_in_amount, buy_in_fee, status[^']*'/);
    expect(selectList, 'the satellite target select list moved').not.toBeNull();
    const list = selectList![0];
    for (const col of [
      'current_level',
      'late_reg_levels',
      'rebuy_levels',
      'current_players',
      'max_players',
      'prize_pool_finalized',
    ]) {
      expect(list, `satellite target select is missing ${col}`).toContain(col);
    }
  });
});

describe('the prize stamp is a checked write', () => {
  it('reports a failed stamp instead of discarding the error', () => {
    expect(MANAGER).toMatch(/satellite_prize_stamp_failed/);
  });
});

describe('a stuck satellite goes somewhere (2026-08-30)', () => {
  it('an undecided COMPLETING satellite is flipped back to RUNNING, a decided one is not', () => {
    const recovery = fs.readFileSync(path.join(HERE, 'tournamentRecovery.ts'), 'utf8');
    expect(recovery).toMatch(/recoverStuckCompleting_satellite_revived/);
    expect(recovery).toMatch(/aliveCount >= 2/);
    // The decided branch still exists and still refuses structure cash.
    expect(recovery).toMatch(/recoverStuckCompleting_satellite_skipped/);
  });
});
