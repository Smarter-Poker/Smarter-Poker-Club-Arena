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
