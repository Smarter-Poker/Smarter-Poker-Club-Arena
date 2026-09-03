/**
 * A PAID REBUY IS NEVER OVERRUN BY THE BUST SWEEP, AND A TOURNAMENT TABLE
 * NEVER PAUSES FOR ONE (Dan, 2026-08-30).
 *
 * The incident, with the production timestamps: rebuy debit 21:13:57.405,
 * elimination UPDATE 21:13:57.911, seat vacated 21:13:59.162. The player paid
 * 200, was granted 30,000 chips, and was stamped out of the tournament half a
 * second later off the sweep's pre-rebuy snapshot.
 *
 * Dan's directive, verbatim: "REBUYS IN A TOURNAMENT SHOULD NOT PAUSE THE
 * ACTION, IT SHOUD TRIGGER THE REBUY OFFER, THEN SIT THE PLAYER REBUYING AT
 * ANY TABLE THAT NEEDS TO BE BALANCED, OR AT ANY SEAT THAT IS OPEN OR WHERE A
 * PLAYER IS NEEDED FIRST, IF THEY TRULY SHOULD BE IN THE SAME TABLE, SAME
 * SEAT, ITS ALLOWED."
 */
import { describe, expect, it } from 'vitest';
import { sliceBetween } from '../testHelpers/sourceWindow.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ELIM = fs.readFileSync(path.join(HERE, 'TournamentManagerEliminations.ts'), 'utf8');
const DEALING = fs.readFileSync(
  path.join(HERE, '..', 'engine', 'ServerTableEngineDealing.ts'),
  'utf8'
);

describe('the elimination CAS re-checks the chips, not just the status', () => {
  it('eliminatePlayer refuses a row whose chips came back above zero', () => {
    // A rebuy leaves status 'playing', so the status CAS alone cannot catch
    // the race; the chips guard is what makes the landed rebuy win.
    const window = sliceBetween(
      ELIM,
      'A LANDED REBUY OUTRANKS A STALE BUST SNAPSHOT',
      'if (updateErr)'
    );
    expect(window).toMatch(/\.lte\('chips', 0\)/);
  });
});

describe('a busted player holds an open decision window, and the felt rolls on', () => {
  it('the sweep defers eliminating anyone whose rebuy offer is still open', () => {
    expect(ELIM).toMatch(/REBUY_DECISION_GRACE_MS/);
    expect(ELIM).toMatch(/rebuyDecisionGraceUntil/);
    // The window closes with the rebuy period: no window, no deferral.
    const block = sliceBetween(ELIM, 'THE REBUY DECISION WINDOW', 'bustedOrdered');
    expect(block).toMatch(/windowOpen/);
    expect(block).toMatch(/prize_pool_finalized/);
  });

  it('a horse that answered this pass is not deferred - its decision is final', () => {
    // Horses decide inside tryTournamentRebuys (their input device); the
    // window is identical for everyone, a horse simply replies immediately.
    expect(ELIM).toMatch(/answered\.has\(b\.user_id\)/);
  });

  it('tournament tables never pause the felt for a rebuy', () => {
    expect(
      DEALING.indexOf('REBUYS IN A TOURNAMENT SHOULD'),
      "Dan's ruling must be quoted at the site it governs"
    ).toBeGreaterThan(-1);
    const block = sliceBetween(DEALING, 'REBUYS IN A TOURNAMENT SHOULD', 'catch (err)');
    expect(block).not.toMatch(/needsRebuyPause = true/);
    // The CASH pause survives untouched — section 10.5 still applies there.
    expect(DEALING).toMatch(/setLoopPhase\('rebuy_pause'\)/);
  });
});

describe('the SQL side matches: a rebuy needs no seat', () => {
  const MIGRATIONS = path.join(HERE, '..', '..', '..', 'supabase', 'migrations');
  it('the latest process_tournament_rebuy only demands a live seat for add-ons', () => {
    const owning = fs
      .readdirSync(MIGRATIONS)
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .filter((f) =>
        fs
          .readFileSync(path.join(MIGRATIONS, f), 'utf8')
          .includes('FUNCTION public.process_tournament_rebuy')
      );
    expect(owning.length).toBeGreaterThan(0);
    const sql = fs.readFileSync(path.join(MIGRATIONS, owning[owning.length - 1]), 'utf8');
    expect(sql).toMatch(/Only an ADD-ON demands a live seat/);
    expect(sql).toMatch(/a rebuy cannot resurrect a settled result/i);
  });
});
