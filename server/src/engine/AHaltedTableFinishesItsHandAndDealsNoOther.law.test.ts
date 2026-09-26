/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A HALTED TABLE FINISHES ITS HAND AND DEALS NO OTHER (binding, 2026-09-21)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Lightning 2.0 Phase 5 converts a Cluster from MUST_MOVE to LIGHTNING while
 * its players stay exactly where they are sitting. The conversion sets
 * `tables.dealing_halted_at` on every table of the Cluster as it enters
 * PENDING_ON, clears it if the conversion aborts back to MUST_MOVE (acceptance
 * F04), and keeps it set while the Cluster is `lightning`.
 *
 * WHAT WAS THERE BEFORE THIS LAW: nothing. Reconnaissance for Phase 5 found
 * that no line of the TypeScript engine read `cash_games.cluster_mode`, and
 * that the three layers that might have noticed a conversion all look away:
 *
 *   - `cash_tables_needing_engine` (GameServer's five-second discovery sweep)
 *     joins `table_seats` to `tables` and never touches `cash_games`, and the
 *     Phase 5 design deliberately leaves every `table_seats` row alive - so a
 *     converting Cluster's tables all still qualify for an engine, and a
 *     reaped one is rebuilt within five seconds;
 *   - `isNextHandPaused()` was seven in-memory booleans, none of them ever set
 *     from Cluster state;
 *   - `stopIfClusterTableClosed()` returns early on `seatedPlayers.length > 0`,
 *     so it speaks only for an EMPTY table, and only once a minute.
 *
 * A converting Cluster would therefore have gone on dealing straight through
 * its own conversion.
 *
 * THE CONTRACT THIS LAW PINS, WHICH IS NARROW ON PURPOSE:
 *
 *   1. `dealing_halted_at IS NOT NULL` stops the NEXT hand. The hand in the
 *      air finishes normally - "do not abruptly kill active hands".
 *   2. Clearing the column starts the table dealing again, with no restart.
 *   3. It closes nothing, drops no engine, unseats nobody and moves no chip.
 *      In particular the gate sits ABOVE the sit-out eviction and above every
 *      seat move, so a halted table cannot cash a player out or move one.
 *   4. It survives an engine being reaped and rebuilt, because the authority
 *      is the row and `start()` reads it.
 *   5. It is a POLLED lock (with `adminPauseLock` and `maintenanceLock`), not
 *      a pause-gate owner: the writer is a transaction that has committed and
 *      gone, so nothing in this process will ever call `releasePauseGate` for
 *      it, and waiting on that gate would return at once and spin the loop.
 *
 *   6. IT IS NOT ONLY THE DEALING LOOP (remediation, 2026-09-25). A table
 *      below `minPlayersToDeal()` lives in `start()`'s wait-for-players loop,
 *      which never reached the dealing loop and so never saw the halt - while
 *      still running `evictExpiredSitOuts` (which cashes a player out),
 *      `executeIdleSeatMoves` and `processPendingAddOns`. That loop now takes
 *      the SAME throttled row re-read (cash Cluster tables only, so a quiet
 *      tournament table's backoff is untouched) and the same polled gate, and
 *      it resumes when the row is cleared.
 *   7. ONE THING ABOVE THE GATE IS NOT A READ, AND THAT IS JUDGED, NOT
 *      MISSED: `prepareNextHand`'s `leave_pending` sweep. A departure the
 *      PLAYER asked for goes through, because every population query the
 *      conversion asks already excludes a `leave_pending` seat, so the sweep
 *      cannot move the number the commit re-asks. The sit-out eviction, which
 *      is the ENGINE's decision about a player who asked for nothing, does
 *      not. The argument lives in full beside the code.
 *
 * Source-text guards in the house style (see
 * ATableThatCannotDealHoldsNobodyForABlind.law.test.ts), plus the behavioural
 * half over a real engine object.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const maybeSingle = vi.fn();
const selectSpy = vi.fn();

vi.mock('../services/supabase/client.js', () => {
  const from = (table: string) => ({
    select: (cols: string) => {
      selectSpy(table, cols);
      return { eq: () => ({ maybeSingle }) };
    },
  });
  return { supabase: { from }, maintenanceSupabase: { from } };
});
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));

/** The wait-for-players loop's two reads, so the real loop can be driven. */
const loadSeatedPlayers = vi.fn();
const loadTable = vi.fn();
vi.mock('../services/supabase.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../services/supabase.js');
  return {
    ...actual,
    loadSeatedPlayers: (...a: unknown[]) => loadSeatedPlayers(...a),
    loadTable: (...a: unknown[]) => loadTable(...a),
  };
});

const { ServerTableEngine } = await import('./ServerTableEngine.js');

const read = (rel: string) => readFileSync(resolve(__dirname, rel), 'utf8');
const BASE = read('./ServerTableEngineBase.ts');
const DEALING = read('./ServerTableEngineDealing.ts');
const TABLES = read('../services/supabase/tables.ts');

/** The dealing loop's halt gate, from its condition to the next member. */
const GATE = (() => {
  const start = DEALING.indexOf('if (this.dealingHaltLock) {');
  expect(start, 'the dealing loop no longer gates on the cluster halt').toBeGreaterThan(-1);
  const end = DEALING.indexOf('await this.evictExpiredSitOuts({ countOrbit: false });', start);
  expect(end, 'the gate is no longer above the sit-out eviction').toBeGreaterThan(start);
  return DEALING.slice(start, end);
})();

/** The one writer of the lock, sliced from its signature to the next member. */
const APPLY = (() => {
  const start = BASE.indexOf('protected applyDealingHaltFromRow(');
  expect(start, 'the halt has no writer any more').toBeGreaterThan(-1);
  const end = BASE.indexOf('protected async stopIfClusterTableClosed(', start);
  expect(end, 'the slice anchor moved; re-anchor this law rather than widening it').toBeGreaterThan(
    start
  );
  return BASE.slice(start, end);
})();

/** A cash table row as `fn_cash_apply_ruleset` leaves one, with no halt on it. */
const liveRow = {
  rake_percent: 5,
  rake_cap_bb: 3,
  bomb_pot_enabled: false,
  ante_enabled: false,
  ante: 0,
  dealing_halted_at: null,
  dealing_halted_reason: null,
};
/** The same row the instant the conversion enters PENDING_ON. */
const haltedRow = {
  ...liveRow,
  dealing_halted_at: '2026-09-21T15:16:18.000Z',
  dealing_halted_reason: 'lightning_pending_on',
};

function engine() {
  const e = new ServerTableEngine('aaaaaaaa-1111-2222-3333-444444444444') as any;
  e.tableInfo = { id: e.tableId, club_id: 'club', game_type: 'cash', cluster_id: 'game-1' };
  e.lastRakeRefreshAtMs = 0;
  return e;
}
const dispose = (e: any) => e.preciseTimer?.dispose?.();

beforeEach(() => {
  maybeSingle.mockReset();
  selectSpy.mockReset();
  // The club read that follows the table read in refreshRakeConfig.
  maybeSingle.mockResolvedValue({ data: null });
  loadTable.mockReset();
  loadSeatedPlayers.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe('a halted table finishes its hand and deals no other', () => {
  it('the halt forbids the next hand, and an unhalted table is untouched', () => {
    const e = engine();
    expect(e.isNextHandPaused(), 'a table nobody halted is not paused').toBe(false);

    e.applyDealingHaltFromRow(haltedRow);
    expect(e.dealingHaltLock).toBe(true);
    expect(e.dealingHaltReason).toBe('lightning_pending_on');
    expect(e.isNextHandPaused(), 'the halt is a named owner of the next-hand gate').toBe(true);

    // A second table of a Cluster that is NOT converting shares nothing: the
    // owner is per-engine and reads only its own row.
    const other = engine();
    other.applyDealingHaltFromRow(liveRow);
    expect(other.isNextHandPaused()).toBe(false);
    dispose(e);
    dispose(other);
  });

  it('F04: clearing the column resumes the table, with no restart', () => {
    const e = engine();
    e.applyDealingHaltFromRow(haltedRow);
    expect(e.isNextHandPaused()).toBe(true);

    // The conversion aborts; the Cluster returns to MUST_MOVE and the row is
    // cleared. The table deals again off the same engine object.
    e.applyDealingHaltFromRow({ ...liveRow });
    expect(e.dealingHaltLock).toBe(false);
    expect(e.dealingHaltReason).toBe(null);
    expect(e.isNextHandPaused(), 'an aborted conversion must let the table resume').toBe(false);
    dispose(e);
  });

  it('a table outside a Cluster, whose row has never carried the column, is not halted', () => {
    const e = engine();
    e.applyDealingHaltFromRow({ rake_percent: 5 });
    expect(e.isNextHandPaused()).toBe(false);
    dispose(e);
  });

  it('the throttled re-read asks for the column and applies both edges', async () => {
    const e = engine();
    maybeSingle.mockResolvedValueOnce({ data: haltedRow });
    await e.refreshRakeConfig(true);
    const cols = String(selectSpy.mock.calls.find((c) => c[0] === 'tables')![1]).split(/,\s*/);
    expect(cols, 'the halt must ride the read that already runs every hand').toContain(
      'dealing_halted_at'
    );
    expect(cols).toContain('dealing_halted_reason');
    expect(e.dealingHaltLock, 'a halt raised under a running engine is honoured').toBe(true);

    maybeSingle.mockResolvedValueOnce({ data: liveRow });
    e.lastRakeRefreshAtMs = 0;
    await e.refreshRakeConfig(true);
    expect(e.dealingHaltLock, 'and so is the clear').toBe(false);
    dispose(e);
  });

  it('a read that fails leaves a halted table halted', async () => {
    const e = engine();
    e.applyDealingHaltFromRow(haltedRow);
    // The row could not be read. Failing OPEN here would resume a converting
    // table on a database blip; failing closed costs one 60-second pass.
    maybeSingle.mockResolvedValueOnce({ data: null });
    e.lastRakeRefreshAtMs = 0;
    await e.refreshRakeConfig(true);
    expect(e.dealingHaltLock).toBe(true);
    dispose(e);
  });

  it('the halt survives the engine being reaped and rebuilt', () => {
    // The authority is the row, so the rebuilt engine reads it in start().
    expect(
      TABLES,
      'loadTable must fetch the column or a rebuilt engine comes back dealing'
    ).toMatch(/dealing_halted_at, dealing_halted_reason/);
    const start = BASE.slice(
      BASE.indexOf('this.tableInfo = tableData as TableInfo;'),
      BASE.indexOf('if (this.tableInfo?.tournament_id) {')
    );
    expect(start).toMatch(/this\.applyDealingHaltFromRow\(this\.tableInfo\);/);

    // ...and a brand-new engine handed that row is halted from its first pass.
    const rebuilt = engine();
    rebuilt.applyDealingHaltFromRow(haltedRow);
    expect(rebuilt.isNextHandPaused()).toBe(true);
    dispose(rebuilt);
  });

  it('the hand in the air is never killed: the gate is the top of the iteration', () => {
    // The loop cannot reach the gate until dealHand() has resolved and the
    // settlement barrier has drained, so "allow already-started hands to
    // resolve normally" is the POSITION of this check, not a second one.
    expect(DEALING.indexOf('if (this.dealingHaltLock) {')).toBeLessThan(
      DEALING.indexOf('await this.dealHand(activePlayers);')
    );
    expect(GATE).not.toMatch(/dealHand|handController|forceFold|abort|cancelHand/);
  });

  it('a halted table unseats nobody, moves no chip and closes nothing', () => {
    // Everything that changes a seat happens BELOW the gate.
    const gateAt = DEALING.indexOf('if (this.dealingHaltLock) {');
    for (const below of [
      'await this.evictExpiredSitOuts({ countOrbit: false });',
      "'announce_seat_moves',",
      'await this.dealHand(activePlayers);',
    ]) {
      expect(gateAt, `${below} must stay below the halt gate`).toBeLessThan(DEALING.indexOf(below));
    }
    // The gate itself does nothing but park and poll.
    expect(GATE).not.toMatch(/stop\(\)|killForRestart|leaveTable|table_seats|stack|unseat/);
    expect(GATE).toMatch(/await this\.sleep\(3000\);\s*continue;/);
    // And the writer touches no seat, no stack and no other table.
    expect(APPLY).not.toMatch(/\.from\(|table_seats|stack|cash_player_session|stop\(\)/);
  });

  it('it is a polled lock, never a pause-gate owner nothing will release', () => {
    const paused = BASE.slice(
      BASE.indexOf('protected isNextHandPaused(): boolean {'),
      BASE.indexOf('protected discardPreparedHandForPause(')
    );
    expect(paused).toMatch(/this\.dealingHaltLock \|\|/);
    // awaitPauseGate is for owners something in this process releases. With
    // only a polled lock raised it returns at once, and the branch continues -
    // a hot spin. All three polled locks are excluded together.
    expect(DEALING).toMatch(
      /if \(!this\.adminPauseLock && !this\.maintenanceLock && !this\.dealingHaltLock\)/
    );
    expect(GATE, 'the halt must not park on a gate nobody will open').not.toMatch(
      /awaitPauseGate|releasePauseGate|handForHandResolve/
    );
  });

  /**
   * A cash Cluster feeder below `minPlayersToDeal()`, driven through the REAL
   * wait-for-players loop with only its leaf reads and its sleep stubbed - the
   * same harness shape theQuietTournamentTableBacksOff.law.test.ts uses.
   */
  function quietFeeder(sleeps: number[], stopAfter: number) {
    const e = new ServerTableEngine('aaaaaaaa-1111-2222-3333-444444444444') as any;
    e.sleep = async (ms: number) => {
      sleeps.push(ms);
      if (sleeps.length >= stopAfter) e.running = false;
    };
    e.seedHandCountFromHistory = async () => {};
    e.restoreButtonFromHistory = async () => {};
    e.checkCrashRecovery = async () => false;
    e.readParkedTimeBanks = async () => {};
    e.resolveOrphanedAddOns = async () => {};
    e.broadcastCurrentState = async () => {};
    e.scheduleHeartbeatCheck = () => {};
    e.restoreSitOutsFromSeats = () => {};
    e.adoptMovedPresence = async () => true;
    e.dealingLoop = vi.fn(async () => {});
    return e;
  }

  it('a short-handed halted table evicts nobody and executes no seat move', async () => {
    // THE CASE THE REMEDIATION WAS WRITTEN FOR. A feeder with one seated
    // player who is sitting out, four minutes into the five-minute eviction
    // clock, when the Cluster halts every table. The engine is reaped and
    // rebuilt, `start()` sets the lock, and the engine enters the wait loop -
    // where, before this, `evictExpiredSitOuts` stood that player up and
    // cashed them out sixty seconds later, in the middle of a transition
    // whose stated law is that it unseats nobody and moves no chip.
    loadTable.mockResolvedValue({
      id: 'aaaaaaaa-1111-2222-3333-444444444444',
      small_blind: 1,
      big_blind: 2,
      max_players: 6,
      game_variant: 'nlh',
      cluster_id: 'game-1',
      ...haltedRow,
    });
    loadSeatedPlayers.mockResolvedValue([
      { user_id: 'u1', seat_number: 1, username: 'p1', stack: 1000, is_sitting_out: true },
    ]);
    maybeSingle.mockResolvedValue({ data: haltedRow });

    const sleeps: number[] = [];
    const e = quietFeeder(sleeps, 4);
    const evict = vi.fn(async () => {});
    const moves = vi.fn(async () => {});
    const addOns = vi.fn(async () => {});
    const holds = vi.fn();
    e.evictExpiredSitOuts = evict;
    e.executeIdleSeatMoves = moves;
    e.processPendingAddOns = addOns;
    e.restoreEntryHoldsFromSeats = holds;

    try {
      await e.start();
      expect(e.dealingHaltLock, 'the quiet loop must READ the halt, not only the dealer').toBe(
        true
      );
      expect(sleeps.length, 'the loop really ran').toBeGreaterThanOrEqual(4);
      expect(evict, 'a halted table cashes nobody out').not.toHaveBeenCalled();
      expect(moves, 'and moves nobody between tables').not.toHaveBeenCalled();
      expect(addOns).not.toHaveBeenCalled();
      expect(holds).not.toHaveBeenCalled();
      expect(e.dealingLoop, 'and never starts dealing').not.toHaveBeenCalled();
    } finally {
      e.running = false;
      await e.stop().catch(() => undefined);
      dispose(e);
    }
  });

  it('...and the same quiet table resumes its idle work when the flag clears', async () => {
    // F04 for a table that was never dealing: the conversion falls back, the
    // row is cleared, and the wait loop picks it up on its own re-read. This
    // is the half Phase 5 feared - a halt a quiet table could never see lift.
    loadTable.mockResolvedValue({
      id: 'aaaaaaaa-1111-2222-3333-444444444444',
      small_blind: 1,
      big_blind: 2,
      max_players: 6,
      game_variant: 'nlh',
      cluster_id: 'game-1',
      ...liveRow,
    });
    loadSeatedPlayers.mockResolvedValue([
      { user_id: 'u1', seat_number: 1, username: 'p1', stack: 1000, is_sitting_out: true },
    ]);
    maybeSingle.mockResolvedValue({ data: liveRow });

    const sleeps: number[] = [];
    const e = quietFeeder(sleeps, 3);
    const evict = vi.fn(async () => {});
    const moves = vi.fn(async () => {});
    e.evictExpiredSitOuts = evict;
    e.executeIdleSeatMoves = moves;
    e.processPendingAddOns = vi.fn(async () => {});

    try {
      await e.start();
      expect(e.dealingHaltLock).toBe(false);
      expect(evict, 'an unhalted quiet table keeps its five-minute clock').toHaveBeenCalled();
      expect(moves, 'and keeps landing its planned moves').toHaveBeenCalled();
    } finally {
      e.running = false;
      await e.stop().catch(() => undefined);
      dispose(e);
    }
  });

  it('the wait loop reads the row, gates on it, and wedges no quiet table', () => {
    // The whole of the wait-for-players loop body.
    const LOOP = BASE.slice(
      BASE.indexOf("this.setLoopPhase('start_wait_for_players');"),
      BASE.indexOf("this.tableFSM.transition('seating');")
    );
    // 1. It re-reads the row. Phase 5's stated reason for NOT gating this loop
    //    was that it could never see the halt lift; that is what this answers,
    //    and it answers it with the re-read that already exists rather than a
    //    second polling mechanism.
    expect(LOOP, 'the quiet loop must re-read the row or the gate below wedges it').toMatch(
      /await this\.refreshRakeConfig\(\);/
    );
    // 2. Cash Cluster tables only. A quiet TOURNAMENT table must not make one
    //    extra request - see theQuietTournamentTableBacksOff.law.test.ts, and
    //    the column is only ever written for a Cluster's cash tables anyway.
    expect(LOOP).toMatch(
      /if \(!this\.isTournamentTable\(\) && this\.tableInfo\?\.cluster_id\) \{\s*await this\.refreshRakeConfig\(\);/
    );
    // 3. The read comes BEFORE the gate, in the same pass.
    const readAt = LOOP.indexOf('await this.refreshRakeConfig();');
    expect(readAt, 'the quiet loop lost its row re-read').toBeGreaterThan(-1);
    const gateAt = LOOP.indexOf('if (this.dealingHaltLock) {');
    expect(gateAt, 'the quiet loop no longer gates on the halt').toBeGreaterThan(-1);
    expect(readAt).toBeLessThan(gateAt);
    // 4. And the gate is above every member that changes a seat.
    for (const below of [
      'await this.processPendingAddOns(this.seatedPlayers);',
      'this.restoreEntryHoldsFromSeats();',
      'await this.evictExpiredSitOuts({ countOrbit: false })',
      'await this.executeIdleSeatMoves()',
    ]) {
      expect(LOOP.indexOf(below), below + ' must stay below the quiet halt gate').toBeGreaterThan(
        gateAt
      );
    }
    // 5. It polls; it does not park on a gate nobody in this process opens.
    const QUIET_GATE = LOOP.slice(gateAt, LOOP.indexOf('continue;', gateAt));
    expect(QUIET_GATE).not.toMatch(/awaitPauseGate|releasePauseGate|handForHandResolve/);
    expect(QUIET_GATE).not.toMatch(/table_seats|unseat|leaveTable|killForRestart/);
    expect(QUIET_GATE).toMatch(/waitForPlayersPause|sleep/);
  });

  it('a halted table is parked BY DESIGN even while its FSM still says waiting', () => {
    // GameServer's zombie reaper, the drain's boundary test, the turn watchdog
    // and /health all ask this. The dealing loop's gate flips the FSM to
    // 'paused', so a DEALING table was covered by accident; a table halted in
    // the wait loop is still 'waiting' and was covered by nothing.
    const e = engine();
    expect(e.isPausedByDesign()).toBe(false);
    e.applyDealingHaltFromRow(haltedRow);
    expect(e.isPausedByDesign(), 'a halted table is stopped ON PURPOSE').toBe(true);
    expect(e.isBetweenHands()).toBe(true);
    expect(e.isParkedByDesign(), 'and between hands it has taken effect').toBe(true);
    // A polled lock stamps no pause clock, so MAX_HEALTHY_PAUSE_MS can never
    // condemn a long conversion.
    expect(e.msPaused()).toBe(0);
    e.applyDealingHaltFromRow(liveRow);
    expect(e.isPausedByDesign()).toBe(false);
    dispose(e);

    // MID-HAND IT CHANGES NOTHING. isParkedByDesign()'s mid-hand branch names
    // only the fences a rebuild would LOSE, and the halt is not one: start()
    // re-reads the row, so a replacement comes up halted. A hand that froze
    // under a halt must still be worked and still be reaped.
    const midHand = engine();
    midHand.applyDealingHaltFromRow(haltedRow);
    midHand.handController = {} as never;
    expect(midHand.isBetweenHands()).toBe(false);
    expect(midHand.isParkedByDesign(), 'a frozen hand is not shielded by a halt').toBe(false);
    dispose(midHand);
  });

  it('the FSM comes back out of paused when the halt lifts', () => {
    // The gate moves 'running' -> 'paused' and nothing moved it back:
    // releasePauseGate() is the only other writer of that edge and no owner in
    // this process releases a polled lock. Left alone, every reader of
    // isPausedByDesign() was told for the life of the process that a table
    // which had resumed dealing was parked on purpose - the watchdogs around
    // it silently off - until the hourly break happened to wash it away.
    const restore = DEALING.slice(
      DEALING.indexOf('AND A TABLE MUST NOT STAY LABELLED PAUSED ONCE THE HALT LIFTS'),
      DEALING.indexOf('if (this.dealingHaltLock) {')
    );
    expect(restore, 'the resume edge must be guarded by EVERY next-hand owner').toMatch(
      /if \(this\.tableFSM\.state === 'paused' && !this\.isNextHandPaused\(\)\) \{\s*this\.tableFSM\.transition\('running'\);/
    );
  });

  it("a player's own leave still completes under a halt; the engine's eviction does not", () => {
    // JUDGED, NOT MISSED. prepareNextHand() runs above the gate and launches
    // processLeavePending, which writes table_seats.left_at and cashes a seat
    // out. It stays there:
    //
    //   - every population query the conversion asks carries
    //     `coalesce(ts.leave_pending, false) = false` - the opening verdict,
    //     the commit's re-ask, the pool-session INSERT and the stranded-player
    //     check - so the seat left the counted set when POST /leave wrote the
    //     flag, outside this engine. Turning `leave_pending` into `left_at`
    //     cannot move the number the commit re-asks, so it cannot be what
    //     sends a conversion back to MUST_MOVE;
    //   - the chip-total assertion reads its two sums inside the commit's own
    //     transaction, over `left_at IS NULL` seats only;
    //   - and refusing it would strand a departed player's money at a table
    //     for an unbounded conversion, to protect a number that cannot change.
    //
    // The sit-out eviction is the opposite case and is stopped: that player
    // asked for nothing, and the cash-out is the engine's own decision on a
    // clock the halt is itself making tick.
    const prepareAt = DEALING.indexOf('protected async prepareNextHand(');
    const gateAt = DEALING.indexOf('if (this.dealingHaltLock) {');
    const sweepAt = DEALING.indexOf('rawSweep = processLeavePending(', prepareAt);
    expect(sweepAt).toBeGreaterThan(prepareAt);
    // The decision is recorded where the code is, not only here.
    const argument = DEALING.slice(
      DEALING.indexOf('A LEAVE THE PLAYER ASKED FOR STILL HAPPENS UNDER A HALT'),
      sweepAt
    );
    expect(argument).toMatch(/leave_pending, false\) = false/);
    expect(argument).toMatch(/JUDGED, NOT MISSED/);
    // The eviction stays below the gate; the leave sweep stays above it.
    expect(gateAt).toBeLessThan(
      DEALING.indexOf('await this.evictExpiredSitOuts({ countOrbit: false });')
    );
    expect(DEALING.indexOf('const leaveSweepCanRace =', prepareAt)).toBeGreaterThan(-1);
    // THE FLIP PIN. prepareNextHand() is CALLED above the gate; that call site
    // is the decision. Moving it below the gate is the other answer, and it
    // must be an argued change, not a quiet one.
    const prepareCallAt = DEALING.indexOf('const nextRoster = await this.prepareNextHand();');
    expect(prepareCallAt, 'the dealing loop no longer calls prepareNextHand').toBeGreaterThan(-1);
    expect(
      prepareCallAt,
      "a player's own leave is allowed to complete under a halt - see the argument beside the sweep"
    ).toBeLessThan(gateAt);
    // ...and the per-player teardown is BELOW the gate, so a halt defers it
    // rather than losing it - and `leaveSweepCanRace` cannot start a second
    // sweep while the first is still un-taken.
    expect(gateAt).toBeLessThan(
      DEALING.indexOf('const cashedOutIds = await this.takePreparedLeavePending();')
    );
    expect(DEALING).toMatch(/this\.preparedLeavePending === null;/);
  });

  it('the latency the halt actually costs is written down where the owner lives', () => {
    const owner = BASE.slice(
      BASE.indexOf('A CLUSTER MAY STOP ITS TABLES DEALING WITHOUT CLOSING ONE OF THEM'),
      BASE.indexOf('protected dealingHaltLock: boolean = false;')
    );
    // The value rides refreshRakeConfig's 60-second throttle. If that changes,
    // this doc must change with it - a stated latency that has quietly stopped
    // being true is worse than none.
    expect(owner).toMatch(/RAKE_CONFIG_TTL_MS \(60s\)/);
    expect(owner).toMatch(/AT MOST 60 SECONDS/);
    expect(BASE).toMatch(/const RAKE_CONFIG_TTL_MS = 60_000;/);
  });
});
