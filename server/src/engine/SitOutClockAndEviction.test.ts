/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE FIVE-MINUTE SIT-OUT BOOT, AND WHY IT NEVER FIRED
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-28: "IT WAS SUPPOSED TO BE FIXED THAT A USER CAN ONLY SIT OUT FOR
 * 5 MINUTES, BEFORE GETTING BOOTED IN A CASH GAME ... BUT FOR SOME REASON THIS
 * NEVER KICKS THE USER OFF THE CASH GAME AFTER THE 5 MIN."
 *
 * The limit itself was correct and had been since 2026-08-21. It never fired
 * because of two separate holes, and each one hid the other:
 *
 *   1. REGISTRATION GAP. `sitOut()` opened with `if (!state) return;` and
 *      `playerStates` was only ever populated inside dealHand() or by a restore
 *      that itself required `is_sitting_out` to already be true in the database.
 *      A player who tapped Sit Out at a table that had not dealt since the
 *      engine booted fell out of that guard silently — no state, no event, no
 *      `is_sitting_out` write, so nothing could ever bootstrap them. The HTTP
 *      handler still answered `{ success: true }`.
 *
 *   2. THE CLOCK WAS NOT PERSISTED. `sitOutSince` lived on an in-memory Map.
 *      restoreSitOutsFromSeats() re-stamped it to Date.now() on every engine
 *      boot, so any table whose engine recycled inside five minutes reset the
 *      countdown forever.
 *
 * These specs pin both holes shut, and pin the tournament exemption open —
 * Dan, same message: sitting out is allowed "AS LONG AS THEY WANT IN A MTT,
 * SPIN OR HEADS UP (BUT THEY WILL BE BLINDED OFF)".
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DisconnectEngine } from './DisconnectEngine.js';
import { PreciseActionTimer } from './PreciseActionTimer.js';
/* Structural windows, never byte counts — a 7000-character window stopped
   covering the code it guarded on 2026-08-28 and stalled publishing for the
   whole estate for 39 minutes.

   The SERVER copy, not tests/helpers/: server/tsconfig.json sets
   `rootDir: ./src`, so importing the app's copy compiles under vitest and then
   fails `tsc` with TS6059. The two are kept byte-identical below their headers
   by tests/unit/sourceWindowMirror.test.ts. */
import { sliceMethod } from '../testHelpers/sourceWindow.js';

const TABLE = 'table-1';
const PLAYER = 'player-1';

describe('sit-out clock', () => {
  let eng: DisconnectEngine;

  beforeEach(() => {
    eng = new DisconnectEngine(new PreciseActionTimer());
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sits out a player the engine has never seen', () => {
    /* HOLE 1. Before the fix this was a silent no-op and the player held their
       seat forever. Nothing calls registerPlayer here on purpose — that is the
       whole point: being asked to sit somebody out IS the proof they are at
       this table. */
    expect(eng.isSittingOut(TABLE, PLAYER)).toBe(false);

    eng.sitOut(TABLE, PLAYER, 'voluntary');

    expect(eng.isSittingOut(TABLE, PLAYER)).toBe(true);
  });

  it('evicts an unregistered player after five minutes, not never', () => {
    eng.sitOut(TABLE, PLAYER, 'voluntary');

    // Four minutes: still theirs.
    vi.advanceTimersByTime(4 * 60 * 1000);
    expect(eng.tickSitOutsAndCollectEvictions(TABLE, [PLAYER])).toEqual([]);

    // Past five: gone.
    vi.advanceTimersByTime(61 * 1000);
    expect(eng.tickSitOutsAndCollectEvictions(TABLE, [PLAYER])).toEqual([PLAYER]);
  });

  it('seeds the clock from a persisted stamp instead of restarting it', () => {
    /* HOLE 2, and this is the exact restart the bug report describes. The
       player sat out four and a half minutes ago; the engine has since
       restarted and is restoring them from `table_seats.sit_out_at`. They must
       be thirty seconds from eviction, NOT five minutes. */
    const satOutAt = Date.now() - 4.5 * 60 * 1000;

    eng.sitOut(TABLE, PLAYER, 'voluntary', satOutAt);

    expect(eng.tickSitOutsAndCollectEvictions(TABLE, [PLAYER])).toEqual([]);
    vi.advanceTimersByTime(31 * 1000);
    expect(eng.tickSitOutsAndCollectEvictions(TABLE, [PLAYER])).toEqual([PLAYER]);
  });

  it('a repeated restore cannot push the clock forward', () => {
    /* restoreSitOutsFromSeats runs on EVERY pass of both the wait loop and the
       dealing loop. If a second call could re-stamp, the countdown would reset
       every three seconds — which is the shape of the original bug, just
       reached from inside one process instead of across a restart. */
    const satOutAt = Date.now() - 4.9 * 60 * 1000;
    eng.sitOut(TABLE, PLAYER, 'voluntary', satOutAt);

    // Later restores, including one claiming a NEWER stamp, must not help them.
    eng.sitOut(TABLE, PLAYER, 'voluntary', Date.now());
    eng.sitOut(TABLE, PLAYER, 'voluntary');

    vi.advanceTimersByTime(7 * 1000);
    expect(eng.tickSitOutsAndCollectEvictions(TABLE, [PLAYER])).toEqual([PLAYER]);
  });

  it('sitting back in clears the clock so the next sit-out gets a full five', () => {
    eng.sitOut(TABLE, PLAYER, 'voluntary', Date.now() - 4.9 * 60 * 1000);
    eng.sitBack(TABLE, PLAYER);
    expect(eng.isSittingOut(TABLE, PLAYER)).toBe(false);

    eng.sitOut(TABLE, PLAYER, 'voluntary');
    vi.advanceTimersByTime(60 * 1000);
    expect(eng.tickSitOutsAndCollectEvictions(TABLE, [PLAYER])).toEqual([]);
  });

  it('a player who is not sitting out is never collected', () => {
    eng.registerPlayer(TABLE, PLAYER);
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(eng.tickSitOutsAndCollectEvictions(TABLE, [PLAYER])).toEqual([]);
  });
});

/**
 * Source-level guards. The wiring below is what turns the unit behaviour above
 * into the reported fix, and it is the wiring that regressed before.
 */
const ENGINE_DIR = join(process.cwd(), 'src', 'engine');
const read = (f: string) => readFileSync(join(ENGINE_DIR, f), 'utf8');

describe('sit-out wiring', () => {
  it('restoreSitOutsFromSeats passes the persisted stamp, not now()', () => {
    const base = read('ServerTableEngineBase.ts');
    const body = sliceMethod(base, 'protected restoreSitOutsFromSeats');

    // It must READ the column and hand it to sitOut as the fourth argument.
    expect(body).toMatch(/p\.sit_out_at/);
    expect(body).toMatch(/Date\.parse\(p\.sit_out_at\)/);
    expect(body).toMatch(/this\.disconnectEngine\.sitOut\(/);
    // A bare three-argument call here is the original bug.
    expect(body).not.toMatch(/sitOut\(this\.tableId,\s*p\.user_id,\s*'voluntary'\s*\)/);
  });

  it('loadSeatedPlayers selects sit_out_at, or the stamp never arrives', () => {
    const tables = readFileSync(
      join(process.cwd(), 'src', 'services', 'supabase', 'tables.ts'),
      'utf8'
    );
    expect(tables).toMatch(/is_sitting_out,\s*sit_out_at/);
    expect(tables).toMatch(/sit_out_at:/);
  });

  it('sitOut registers an unknown player rather than returning', () => {
    const body = sliceMethod(read('DisconnectEngine.ts'), '  sitOut(');
    expect(body).toMatch(/this\.registerPlayer\(tableId, playerId\)/);
  });

  it('the eviction sweep still exempts tournaments', () => {
    /* Dan: sitting out is unlimited "IN A MTT, SPIN OR HEADS UP (BUT THEY WILL
       BE BLINDED OFF)". `isTournamentTable()` is one test covering all three,
       so this single early return is the whole exemption. */
    const body = sliceMethod(
      read('ServerTableEngineBase.ts'),
      'protected async evictExpiredSitOuts'
    );
    expect(body).toMatch(/if\s*\(this\.isTournamentTable\(\)\)\s*return;/);
  });

  it('a deferred sit-out is drained even when the hand never settles', () => {
    /* pendingSitOut had exactly one drain (settlement step 5.9), and a hand
       killed by HAND_SAFETY_TIMEOUT skips settlement entirely — so the request
       was dropped and the player held their seat believing they had sat out. */
    const dealing = read('ServerTableEngineDealing.ts');
    expect(dealing).toMatch(/this\.handController === null && this\.pendingSitOut\.size > 0/);
    expect(dealing).toMatch(/this\.pendingSitOut\.clear\(\)/);
  });

  it('the broadcast reports real sit-out state, not the hand roster copy', () => {
    /* The roster's `is_sitting_out` is hardcoded false so HandController deals
       a sat-out tournament player in. Publishing it told every client that
       nobody was ever sitting out, which is why the tag was invisible. */
    const eng = read('ServerTableEngine.ts');
    expect(eng).not.toMatch(/is_sitting_out: p\.is_sitting_out \?\? false/);
    const hits = eng.match(/is_sitting_out: this\.disconnectEngine\.isSittingOut\(/g) || [];
    // Live broadcast, resync (getTableState) and the idle publish.
    expect(hits.length).toBeGreaterThanOrEqual(3);
  });
});

describe('a busted cash seat is released', () => {
  const dealing = read('ServerTableEngineDealing.ts');

  it('stands up a cash player who did not rebuy', () => {
    /* Dan: "MAKE SURE THAT THE USER GETS REMOVED FROM THE TABLE AS SOON AS THEY
       HAVE NO CHIPS." Before this there was no path at all that removed a
       busted human from a cash table. */
    expect(dealing).toMatch(/protected async standUpBustedCashPlayers\(\)/);
    expect(dealing).toMatch(/this\.standUpBustedCashPlayers\(\)/);
  });

  it('sweeps at the top of the loop, beside the horse recovery it mirrors', () => {
    /* Placement is load-bearing, not tidiness. Settlement can finish its
       accepted-hand transaction while post-hand cleanup is still in flight, so
       an END-of-hand cleanup check can race that boundary and never get another
       chance once the player leaves `activePlayers`. The top of the loop is
       after `await postHandTasksPromise`. */
    const horseAt = dealing.indexOf('this.recoverBustedSeatedHorses()');
    const humanAt = dealing.indexOf('this.standUpBustedCashPlayers()');
    expect(horseAt).toBeGreaterThan(-1);
    expect(humanAt).toBeGreaterThan(horseAt);
    // Same tick, not half a loop apart: CLAUDE.md 10.5, timing is treatment.
    expect(humanAt - horseAt).toBeLessThan(2000);
  });

  it('never stands up a tournament player - elimination owes them a place', () => {
    const body = sliceMethod(dealing, 'protected async standUpBustedCashPlayers');
    expect(body).toMatch(/if\s*\(this\.isTournamentTable\(\)\)\s*return;/);
  });

  it('will not take a seat off a player whose buy-in is still in flight', () => {
    /* A 0-chip seat is not always a busted seat: a player who has just sat down
       and is waiting on `table_pending_addons` is legally at zero and has
       already been debited. */
    const body = sliceMethod(dealing, 'protected async standUpBustedCashPlayers');
    expect(body).toMatch(/this\.pendingAddOns\.has\(player\.user_id\)/);
    expect(body).toMatch(/BUSTED_GRACE_MS/);
    expect(dealing).toMatch(/static readonly BUSTED_GRACE_MS/);
  });

  it('never removes a player who is all-in in a live hand', () => {
    const body = sliceMethod(dealing, 'protected async standUpBustedCashPlayers');
    expect(body).toMatch(/is_all_in && !inHand\.is_folded/);
  });

  it('leaves through the money path so the exit is accounted for', () => {
    /* atomicCashout takes the seat lock and credits under an idempotency key.
       Deleting or hand-stamping the row instead is what put 48 chips nowhere on
       2026-08-25 (CLAUDE.md 11.5) and is what fn_unaccounted_seat_exits now
       reports on. */
    const body = sliceMethod(dealing, 'protected async standUpBustedCashPlayers');
    expect(body).toMatch(/await atomicCashout\(/);
    expect(body).not.toMatch(/\.delete\(\)/);
  });

  it('only pauses for a rebuy the player can actually afford', () => {
    /* Dan: "CHECK IF THEY HAVE ENOUGH CHIPS TO REBUY, (40 BB MINIMUM). IF THEY
       DO, YOU GIVE THEM THE 5 SECOND PERIOD TO REBUY OR DECLINE." */
    expect(dealing).toMatch(/protected async anyBustedPlayerCanAffordARebuy\(/);
    expect(dealing).toMatch(/await this\.anyBustedPlayerCanAffordARebuy\(justBustedPlayers\)/);
    // The old unconditional pause is gone.
    expect(dealing).not.toMatch(/needsRebuyPause = true; \/\/ Cash games always have rebuy/);
  });

  it('the 40BB floor is the shared definition, not a fifth local answer', () => {
    expect(dealing).toMatch(/cashMinBuyIn/);
    const cfg = readFileSync(join(process.cwd(), 'src', 'config', 'cashBuyIn.ts'), 'utf8');
    expect(cfg).toMatch(/CASH_MIN_BB = 40/);
  });
});
