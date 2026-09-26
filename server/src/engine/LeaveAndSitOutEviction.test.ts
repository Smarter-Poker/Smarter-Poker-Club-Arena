/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  LEAVE TABLE IS THE RESET BUTTON, AND A SIT-OUT IS NOT A LEASE
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-25, from live play, verbatim:
 *
 *   "IF YOU ARE SITTING OUT IT NEVER KICKS YOU OFF THE TABLE. YOU CAN LITERALLY
 *    HOLD THAT SEAT FOREVER. IT SHOULD BE 2 ORBITS OR 5 MINUTES, WHICHEVER IS
 *    FIRST AND YOU GET AUTO BOOTED."
 *
 *   "IF YOU ARE SITTING OUT BUT CLICK LEAVE TABLE, IT DOESN'T LEAVE THE TABLE,
 *    IT SILENTLY FAILS. LEAVE TABLE SHOULD ALWAYS OVERRIDE ANYTHING ELSE...
 *    LEAVE TABLE IS LIKE THE RESET BUTTON, CLEARS EVERYTHING FROM THAT TABLE."
 *
 * The behavioural half runs against the real DisconnectEngine. The wiring half
 * is source-text, because "is this called from the loop that actually runs" is
 * a fact about a call site, not about a function.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { DisconnectEngine } from './DisconnectEngine.js';
import { sliceEnclosingBlock, sliceMethod, sliceStatement } from '../testHelpers/sourceWindow.js';

vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));

const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
const read = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf8');

const BASE = strip(read('src/engine/ServerTableEngineBase.ts'));
const DEALING = strip(read('src/engine/ServerTableEngineDealing.ts'));
const SEATING = strip(read('src/engine/ServerTableEngineSeating.ts'));

const TABLE = 'table-evict';
const SITTER = 'sitter';

function makeEngine() {
  const timer = {
    scheduleTimer: vi.fn(),
    cancelTimer: vi.fn(),
    clearTable: vi.fn(),
  } as unknown as ConstructorParameters<typeof DisconnectEngine>[0];
  return new DisconnectEngine(timer, () => {});
}

function seatSittingOut(de: DisconnectEngine, id = SITTER) {
  de.registerPlayer(TABLE, id);
  de.sitOut(TABLE, id, 'voluntary');
  return id;
}

/* Title corrected 2026-08-29. It read "an orbit is a HAND, not a loop
   iteration" — the previous fix's landing spot, and the second of three
   answers this counter has had. An orbit is a BUTTON ROTATION. A hand is not
   one, a loop iteration is not one, and at 6-max the difference between the
   last two answers is a factor of six. */
describe('an orbit is a BUTTON ROTATION, not a hand and not a loop iteration', () => {
  it('an idle tick does not advance the orbit count', () => {
    // THE BUG: the counter was bumped by the dealing loop's own tick, which
    // fires once per hand while dealing and once per 3-SECOND IDLE TICK while
    // not. "Removed after the button passes them twice" silently became
    // "removed after about nine seconds" on a quiet table.
    const de = makeEngine();
    seatSittingOut(de);
    for (let i = 0; i < 20; i++) {
      expect(de.tickSitOutsAndCollectEvictions(TABLE, [SITTER], { countOrbit: false })).toEqual([]);
    }
  });

  it('evicts once the button has genuinely passed twice', () => {
    /* ── CORRECTED 2026-08-29 (Dan's call) ────────────────────────────────
       This used to read: "SITOUT_MAX_ORBITS is 2 and the check is strictly
       greater, so the THIRD dealt hand is the one that removes them." Both
       halves of that sentence were bugs, and the test's own title gave it
       away — it says "passed twice" and asserted three.

         1. `>` against a constant named MAX_ORBITS = 2 fired on the third.
            Dan's rule is "removed after the button passes them TWICE": the
            second pass is the one that removes them. Now `>=`.
         2. "dealt hand" is not an orbit. The caller counted once per DEAL, so
            at a 6-max table this was three hands out of a twelve-hand
            allowance — a player removed roughly four times sooner than the
            rule they were told. The caller now counts a real button wrap.

       So: two counted orbits, and the second one evicts. */
    const de = makeEngine();
    seatSittingOut(de);
    expect(de.tickSitOutsAndCollectEvictions(TABLE, [SITTER], { countOrbit: true })).toEqual([]);
    expect(de.tickSitOutsAndCollectEvictions(TABLE, [SITTER], { countOrbit: true })).toEqual([
      SITTER,
    ]);
  });

  it('defaults to NOT counting an orbit, so a careless caller cannot over-count', () => {
    const de = makeEngine();
    seatSittingOut(de);
    for (let i = 0; i < 10; i++) de.tickSitOutsAndCollectEvictions(TABLE, [SITTER]);
    expect(de.tickSitOutsAndCollectEvictions(TABLE, [SITTER])).toEqual([]);
  });
});

describe('the five-minute half works on a table that has stopped dealing', () => {
  it('evicts on the clock with ZERO orbits counted', () => {
    // This is the case Dan hit: the table goes quiet, no hand is ever dealt
    // again, and the seat is held forever. The time check must not depend on
    // an orbit ever passing.
    const de = makeEngine();
    seatSittingOut(de);
    const state = (
      de as unknown as { playerStates: Map<string, { sitOutSince: number | null }> }
    ).playerStates.get(`${TABLE}:${SITTER}`)!;
    state.sitOutSince = Date.now() - 5 * 60 * 1000 - 1;

    expect(de.tickSitOutsAndCollectEvictions(TABLE, [SITTER], { countOrbit: false })).toEqual([
      SITTER,
    ]);
  });

  it('does not evict a player four minutes in', () => {
    const de = makeEngine();
    seatSittingOut(de);
    const state = (
      de as unknown as { playerStates: Map<string, { sitOutSince: number | null }> }
    ).playerStates.get(`${TABLE}:${SITTER}`)!;
    state.sitOutSince = Date.now() - 4 * 60 * 1000;
    expect(de.tickSitOutsAndCollectEvictions(TABLE, [SITTER], { countOrbit: false })).toEqual([]);
  });

  it('leaves a player who is NOT sitting out entirely alone', () => {
    const de = makeEngine();
    de.registerPlayer(TABLE, 'active-player');
    for (let i = 0; i < 10; i++) {
      expect(
        de.tickSitOutsAndCollectEvictions(TABLE, ['active-player'], { countOrbit: true })
      ).toEqual([]);
    }
  });
});

describe('the eviction runs where the table actually is', () => {
  it('is a shared method, not code trapped inside the dealing loop', () => {
    expect(BASE).toMatch(/protected async evictExpiredSitOuts\(/);
  });

  it('runs from the START-UP WAIT LOOP - the case that could hold a seat forever', () => {
    // start() parks in a wait-for-players loop until the table has enough seats
    // to deal, and only then launches dealingLoop. A table below the minimum
    // never reached the sweep at all, which is exactly when the last player
    // sits out and nothing can remove them.
    const at = BASE.indexOf('start_wait_for_players');
    expect(at).toBeGreaterThan(-1);
    const loop = sliceEnclosingBlock(BASE, 'start_wait_for_players');
    expect(loop).toMatch(/evictExpiredSitOuts\(\{ countOrbit: false \}\)/);
  });

  it('runs from the dealing loop too, without counting an orbit there', () => {
    expect(DEALING).toMatch(/evictExpiredSitOuts\(\{ countOrbit: false \}\)/);
  });

  it('counts the orbit on a BUTTON WRAP, which is the only place one passes', () => {
    /* RE-AIMED 2026-08-29. This pinned "at the DEAL", which was the previous
       fix's landing spot and still wrong: a deal is a HAND, and at 6-max an
       orbit is about six of them, so "2 orbits" was being enforced as 3 hands.
       The genuine signal was already being computed a line away for time-bank
       refills — `prevButtonSeat > 0 && dealerSeat <= prevButtonSeat` — and the
       counter now rides it.

       Pinned on the ORBIT-COMPLETE condition rather than on a byte offset, so
       moving the block cannot quietly re-point it at the deal again. */
    const at = DEALING.indexOf('const orbitComplete =');
    expect(at, 'the orbit-wrap detector has moved or gone').toBeGreaterThan(-1);
    expect(DEALING).toMatch(
      /const orbitComplete =\s*prevButtonSeat > 0 && dealerSeat <= prevButtonSeat;/
    );
    expect(DEALING).toMatch(/if \(orbitComplete && !this\.isTournamentTable\(\)\)/);
    const after = sliceEnclosingBlock(DEALING, 'orbitComplete && !this.isTournamentTable()');
    expect(after).toMatch(/countOrbit: true/);
  });

  it('never stands up a tournament sit-out', () => {
    // A tournament sit-out is blinded off by design; removing the seat would
    // break the tournament.
    const at = BASE.indexOf('protected async evictExpiredSitOuts');
    const body = sliceMethod(BASE, 'protected async evictExpiredSitOuts');
    expect(body).toMatch(/if \(this\.isTournamentTable\(\)\) return;/);
  });
});

describe('Leave Table overrides everything', () => {
  it('defers ONLY for a player with a live hand, not merely because a hand is running', () => {
    // THE BUG: the branch asked "is a hand running at this table", not "is THIS
    // PLAYER in it". A sitting-out player is excluded from the deal, so they
    // took the mid-hand path anyway: no auto-fold (they have no engine player),
    // and the seat was only flagged leave_pending.
    expect(SEATING).toMatch(/const playerInLiveHand = handState\?\.players\.find\(/);
    expect(SEATING).toMatch(/if \(this\.handController !== null && playerInLiveHand\)/);
  });

  it('a folded participant waits for settlement before cashout', () => {
    // Folding ends winning eligibility, not ownership of the unsettled contribution.
    // The prior source pin required the early-cashout bug reproduced behaviorally.
    const body = sliceStatement(SEATING, 'const playerInLiveHand');
    expect(body).toMatch(/p\.user_id === userId/);
    expect(body).not.toMatch(/!p\.is_folded/);
  });

  it('a stranded leave_pending row is swept even if no hand ever completes', () => {
    // processLeavePending's only other caller is settlement step 6. If the
    // table dropped below the minimum to deal, or the hand died on the safety
    // timeout (which skips settlement), the flag was never processed: the
    // player was gone from their screen, still in the seat, chips still on the
    // table, and nothing looked at it again.
    expect(DEALING).toMatch(/'leave_pending'/);
    expect(DEALING).toMatch(/processLeavePending\(/);
  });

  it('a swept leave tears down the same per-player state settlement does', () => {
    const at = DEALING.indexOf("'leave_pending'");
    const body = sliceEnclosingBlock(DEALING, "'leave_pending'");
    // 2026-09-25 (Lightning halt remediation): the teardown moved into ONE
    // helper, `releaseDepartedSeats`, so the halted dealing loop and the quiet
    // loop's queued-leave sweep forget a leaver exactly as this sweep does.
    // The pin follows it: the sweep calls the helper, and the helper does the
    // whole teardown.
    expect(body).toMatch(/this\.releaseDepartedSeats\(cashedOutIds\);/);
    const helper = sliceMethod(BASE, 'protected releaseDepartedSeats(');
    expect(helper).toMatch(/unregisterPlayer/);
    // 2026-09-25: the bank and its metadata leave together.
    expect(helper).toMatch(/forgetTimeBank/);
    expect(helper).toMatch(/seatedPlayers = this\.seatedPlayers\.filter/);
  });
});
