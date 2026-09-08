/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE HELD-EMPTY HOLD ROTATES. IT IS NOT A LIFE SENTENCE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-26: "LEAVE ... 33% OF ALL SPINS AND 50% OF HEADS UP [EMPTY]."
 *
 * The rule shipped at 00:56 UTC on 2026-08-27 hashing the tournament id ALONE,
 * so a board that rolled held-empty was held empty forever. Combined with how
 * the board keeper decides what to open, that killed the entire seat-first
 * product in about two hours:
 *
 *   1. ensureBoardOpen treats any joinable REGISTERING instance as COVERING
 *      its price point, and opens no replacement while one exists.
 *   2. A held-empty instance never fills, so it never starts, so it never
 *      leaves REGISTERING.
 *   3. Its price point is covered by a husk, permanently.
 *   4. A NOT-held instance fills, starts, completes, and is replaced by a
 *      fresh instance which RE-ROLLS the hold.
 *
 * Every price point keeps re-rolling until it draws "held", and then it is
 * stuck. An absorbing Markov chain, and the absorbing state is a dead game.
 *
 * MEASURED ON PRODUCTION, ~20 hours after it shipped:
 *   - Spin starts fell from ~300/hour to 1/hour; Heads-Up from ~150/hour to 0.
 *   - The 49 surviving REGISTERING boards were 90% under the 33 threshold and
 *     100% under 50 — the board had become a sieve retaining exactly the
 *     held-empty rolls.
 *   - The hash is NOT skewed: 2,000 random uuids gave 33%/50%, and the last
 *     1,000 COMPLETED seat-first games gave 30%/47%. It was survivorship.
 *
 * This is the same shape as the husk incident in seatFirstBoardAndCounts:
 * one un-startable row wedges one price point forever. The lesson that did not
 * carry over is that ANY permanent reason a seat-first game cannot start is a
 * board-killer, not a stalled game.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { seatFirstHeldEmpty, SEAT_FIRST_EMPTY_BUCKET_MS } from './TournamentRecurringService.js';
import { FILL_BUCKET_MS } from './HorseBehavior.js';

// A stable, structured id set — uuids, which is what this hash actually sees.
function ids(n: number, salt = 'board'): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const hex = (i + 1).toString(16).padStart(12, '0');
    out.push(`${salt.padEnd(8, '0').slice(0, 8)}-1af3-4576-959b-${hex}`);
  }
  return out;
}

const T0 = Date.UTC(2026, 7, 27, 12, 0, 0);

describe('the share of the board held empty is still what Dan asked for', () => {
  it('holds roughly a third of Spins at any given instant', () => {
    const board = ids(600, 'spin');
    const held = board.filter((id) => seatFirstHeldEmpty(id, 3, T0)).length;
    expect(held / board.length).toBeGreaterThan(0.2);
    expect(held / board.length).toBeLessThan(0.46);
  });

  it('holds roughly half of Heads-Up at any given instant', () => {
    const board = ids(600, 'hu');
    const held = board.filter((id) => seatFirstHeldEmpty(id, 2, T0)).length;
    expect(held / board.length).toBeGreaterThan(0.37);
    expect(held / board.length).toBeLessThan(0.63);
  });
});

describe('no price point can be held empty forever', () => {
  /**
   * THE REGRESSION. With the hold keyed on the id alone this test fails for
   * exactly the ~33% of ids that roll held — they were held in every bucket
   * from the moment they were created until somebody noticed twenty hours
   * later.
   */
  it('every board becomes fillable within a day, whatever its id', () => {
    const board = ids(400, 'spin');
    const bucketsInADay = Math.ceil((24 * 60 * 60_000) / SEAT_FIRST_EMPTY_BUCKET_MS);
    const neverFillable = board.filter((id) => {
      for (let b = 0; b < bucketsInADay; b++) {
        if (!seatFirstHeldEmpty(id, 3, T0 + b * SEAT_FIRST_EMPTY_BUCKET_MS)) return false;
      }
      return true;
    });
    expect(neverFillable).toEqual([]);
  });

  /**
   * CONSECUTIVE BUCKETS MUST BE INDEPENDENT.
   *
   * Folding the bucket into `horseHash` naively leaves neighbouring buckets
   * correlated — the first draft of this fix did exactly that and this test
   * caught a board held for 8 straight buckets, four hours, which is the same
   * bug in miniature. The ceiling is deliberately loose: at a 1-in-3 hold, 12
   * consecutive holds is a 1-in-a-million event per board, so this cannot flake,
   * but any LATCHING behaviour fails it immediately.
   */
  it('a held board is fillable again within a few buckets, not eventually', () => {
    const board = ids(400, 'spin');
    let worstRun = 0;
    let worstId = '';
    for (const id of board) {
      let run = 0;
      for (let b = 0; b < 48; b++) {
        const held = seatFirstHeldEmpty(id, 3, T0 + b * SEAT_FIRST_EMPTY_BUCKET_MS);
        run = held ? run + 1 : 0;
        if (run > worstRun) {
          worstRun = run;
          worstId = id;
        }
      }
    }
    expect(worstRun, `board ${worstId} stayed held for ${worstRun} straight buckets`).toBeLessThan(
      12
    );
  });

  it('the verdict is stable WITHIN a bucket, so a board does not flicker', () => {
    const id = ids(1, 'spin')[0];
    const start = Math.floor(T0 / SEAT_FIRST_EMPTY_BUCKET_MS) * SEAT_FIRST_EMPTY_BUCKET_MS;
    const first = seatFirstHeldEmpty(id, 3, start);
    for (const offset of [1, 1000, 60_000, SEAT_FIRST_EMPTY_BUCKET_MS - 1]) {
      expect(seatFirstHeldEmpty(id, 3, start + offset)).toBe(first);
    }
  });

  it('the seat-first bucket is shorter than the cash-room bucket', () => {
    /* A cash table is long-lived, so a 2h hold is a fraction of its life. A
       Spin instance lives minutes, so a 2h hold outlives many whole games —
       which is precisely how one roll ossified a price point for a day. */
    /* 2026-09-02: the cash sibling this is compared against is no longer the
       held-empty bucket - Dan's new occupancy rule replaced the hold with a
       full/sporadic character on a THREE-HOUR bucket. The property here is
       unchanged and still the point: a seat-first hold must rotate FASTER than
       the cash-table character does, because a Spin board that holds still for
       hours is a price point nobody can buy. */
    expect(SEAT_FIRST_EMPTY_BUCKET_MS).toBeLessThan(FILL_BUCKET_MS);
    expect(SEAT_FIRST_EMPTY_BUCKET_MS).toBeGreaterThanOrEqual(5 * 60_000);
  });
});

describe('the hold never strands a board that already has players', () => {
  const SRC = readFileSync(resolve(__dirname, './TournamentRecurringService.ts'), 'utf8');

  /**
   * The second class of permanently stuck game: a board that opened NOT held
   * (two horses seated, one seat to go) and then had the hold roll on later
   * was refused its final horse and sat at 2/3 forever — visibly alive,
   * impossible to start, and covering its price point the whole time.
   * Six Spins and five Heads-Up games were in exactly that state.
   */
  it('the gate only applies to a board with nobody in it', () => {
    const gateAt = SRC.lastIndexOf('seatFirstHeldEmpty(');
    expect(gateAt).toBeGreaterThan(-1);
    const gate = SRC.slice(gateAt - 400, gateAt);
    expect(gate).toMatch(/liveCount === 0/);
  });

  it('a skipped board is reported, so a dead board can never be silent again', () => {
    expect(SRC).toMatch(/noteSeatFirstHeld\(tournamentId\)/);
    expect(SRC).toMatch(/held-empty: \$\{n\} seat-first board\(s\) skipped/);
  });
});
