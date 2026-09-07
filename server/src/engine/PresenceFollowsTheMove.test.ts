/**
 * PRESENCE FOLLOWS THE PLAYER ACROSS A MOVE (2026-09-05)
 *
 * `docs/changelog/2026-09-05-the-must-move-lobby.md` shipped the must-move
 * engine with this owed: "presence is not transferred across a move (the
 * client re-subscribes)". The destination engine met every arriving player as
 * a stranger and `registerPlayer` seeds a stranger as fully present with a
 * clean record, so a must-move handed a sitting-out player an active seat, an
 * absent player a present one, a struck player a forgiven one and an
 * over-blinded player a refilled away-blind budget.
 *
 * The first two `it`s here are the ones that describe what a player sees, and
 * each has its control: the same handoff NOT done reproduces the old bug, so
 * a future change that quietly stops depositing turns them red rather than
 * passing on a coincidence.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DisconnectEngine } from './DisconnectEngine.js';
import { PreciseActionTimer } from './PreciseActionTimer.js';
import {
  claimMovedPresence,
  depositMovedPresence,
  movedPresenceCount,
  resetMovedPresence,
  MOVED_PRESENCE_FRESH_MS,
} from './SeatMovePresence.js';

const FEEDER = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const MAIN2 = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const PLAYER = 'cccccccc-3333-4333-8333-cccccccccccc';

const read = (p: string) => readFileSync(resolve(__dirname, p), 'utf8');

/** What the engine does at the FROM table, without standing an engine up. */
function handOver(source: DisconnectEngine, playerId: string, toTableId: string): void {
  const fsm = source.getFsmState(FEEDER, playerId);
  if (!fsm) return;
  depositMovedPresence(playerId, toTableId, { fsm, fromTableId: FEEDER, timeBank: null });
  source.unregisterPlayer(FEEDER, playerId);
}

/** What the engine does at the TO table on its next seat sweep. */
function adopt(destination: DisconnectEngine, playerId: string, tableId: string): number {
  const carried = claimMovedPresence(playerId, tableId);
  if (!carried) return 0;
  return destination.restoreFsmStates(tableId, { [playerId]: carried.fsm });
}

describe('a player arrives at the new table as the player who left the old one', () => {
  beforeEach(() => {
    resetMovedPresence();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-05T06:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
    resetMovedPresence();
  });

  it('a SITTING OUT player arrives sitting out, not active', () => {
    const feeder = new DisconnectEngine(new PreciseActionTimer());
    feeder.registerPlayer(FEEDER, PLAYER);
    // Sat out four minutes ago, of their own accord.
    feeder.sitOut(FEEDER, PLAYER, 'voluntary', Date.now() - 4 * 60_000);
    expect(feeder.isSittingOut(FEEDER, PLAYER)).toBe(true);

    handOver(feeder, PLAYER, MAIN2);

    const main2 = new DisconnectEngine(new PreciseActionTimer());
    expect(adopt(main2, PLAYER, MAIN2)).toBe(1);
    expect(main2.isSittingOut(MAIN2, PLAYER)).toBe(true);
    // AND the sit-out's own five-minute eviction clock is the same clock, not
    // a fresh one the move handed back. One more minute and it fires.
    expect(main2.getState(MAIN2, PLAYER)!.sitOutSince).toBe(Date.now() - 4 * 60_000);
    vi.advanceTimersByTime(61_000);
    expect(main2.tickSitOutsAndCollectEvictions(MAIN2, [PLAYER])).toEqual([PLAYER]);
  });

  it('THE CONTROL: without the handoff that same player arrives active', () => {
    const main2 = new DisconnectEngine(new PreciseActionTimer());
    main2.registerPlayer(MAIN2, PLAYER); // what the destination did before
    expect(main2.isSittingOut(MAIN2, PLAYER)).toBe(false);
  });

  it('an AWAY player arrives away, not present', () => {
    const feeder = new DisconnectEngine(new PreciseActionTimer());
    feeder.registerPlayer(FEEDER, PLAYER);
    // Their transport went away; nothing has been heard since.
    feeder.markDisconnected(FEEDER, PLAYER);
    expect(feeder.isAway(FEEDER, PLAYER)).toBe(true);

    handOver(feeder, PLAYER, MAIN2);

    const main2 = new DisconnectEngine(new PreciseActionTimer());
    expect(adopt(main2, PLAYER, MAIN2)).toBe(1);
    expect(main2.isAway(MAIN2, PLAYER)).toBe(true);
    expect(main2.isConnected(MAIN2, PLAYER)).toBe(false);
  });

  it('THE CONTROL: without the handoff that same player arrives present', () => {
    const main2 = new DisconnectEngine(new PreciseActionTimer());
    main2.registerPlayer(MAIN2, PLAYER);
    expect(main2.isAway(MAIN2, PLAYER)).toBe(false);
    expect(main2.isConnected(MAIN2, PLAYER)).toBe(true);
  });

  it('the strike count and the away-blind budget are not forgiven by a move', () => {
    const feeder = new DisconnectEngine(new PreciseActionTimer());
    feeder.registerPlayer(FEEDER, PLAYER);
    feeder.markDisconnected(FEEDER, PLAYER);
    feeder.getState(FEEDER, PLAYER)!.consecutiveTimeouts = 2;
    // One of the two blinds Dan's cap allows while away is already spent.
    feeder.noteBlindChargedWhileAway(FEEDER, PLAYER, 'sb');

    handOver(feeder, PLAYER, MAIN2);
    const main2 = new DisconnectEngine(new PreciseActionTimer());
    adopt(main2, PLAYER, MAIN2);

    const s = main2.getState(MAIN2, PLAYER)!;
    expect(s.consecutiveTimeouts).toBe(2);
    expect(s.awayBlindSbCharged).toBe(true);
    expect(s.awayBlindBbCharged).toBe(false);
    // So the very next big blind taken while away ends the seat, exactly as
    // it would have at the table they left.
    main2.noteBlindChargedWhileAway(MAIN2, PLAYER, 'bb');
    expect(main2.collectAwayBlindEvictions(MAIN2, [PLAYER])).toEqual([PLAYER]);
  });

  it('a live observation at the destination wins over what was carried', () => {
    const feeder = new DisconnectEngine(new PreciseActionTimer());
    feeder.registerPlayer(FEEDER, PLAYER);
    feeder.markDisconnected(FEEDER, PLAYER);
    handOver(feeder, PLAYER, MAIN2);

    // The client re-subscribed and beat the seat sweep to it.
    const main2 = new DisconnectEngine(new PreciseActionTimer());
    main2.registerPlayer(MAIN2, PLAYER);
    expect(adopt(main2, PLAYER, MAIN2)).toBe(0);
    expect(main2.isConnected(MAIN2, PLAYER)).toBe(true);
  });
});

describe('the handoff itself', () => {
  beforeEach(() => resetMovedPresence());
  afterEach(() => resetMovedPresence());

  it('is claimed exactly once', () => {
    depositMovedPresence(PLAYER, MAIN2, {
      fsm: { state: 'SAT_OUT', sinceMs: 1, graceDeadlineMs: null },
      fromTableId: FEEDER,
      timeBank: null,
    });
    expect(movedPresenceCount()).toBe(1);
    expect(claimMovedPresence(PLAYER, MAIN2)).not.toBeNull();
    expect(claimMovedPresence(PLAYER, MAIN2)).toBeNull();
    expect(movedPresenceCount()).toBe(0);
  });

  it('is not claimed by a different table', () => {
    depositMovedPresence(PLAYER, MAIN2, {
      fsm: { state: 'SAT_OUT', sinceMs: 1, graceDeadlineMs: null },
      fromTableId: FEEDER,
      timeBank: null,
    });
    expect(claimMovedPresence(PLAYER, FEEDER)).toBeNull();
    expect(claimMovedPresence(PLAYER, MAIN2)).not.toBeNull();
  });

  it('goes stale rather than describing a table that has since dealt', () => {
    const t0 = 1_757_052_000_000;
    depositMovedPresence(
      PLAYER,
      MAIN2,
      {
        fsm: { state: 'DISCONNECTED', sinceMs: t0, graceDeadlineMs: null },
        fromTableId: FEEDER,
        timeBank: null,
      },
      t0
    );
    expect(claimMovedPresence(PLAYER, MAIN2, t0 + MOVED_PRESENCE_FRESH_MS + 1)).toBeNull();
  });

  it('carries the time bank, which the seat row deliberately cannot', () => {
    depositMovedPresence(PLAYER, MAIN2, {
      fsm: { state: 'CONNECTED', sinceMs: 1, graceDeadlineMs: null },
      fromTableId: FEEDER,
      timeBank: {
        remainingSeconds: 11,
        usesRemaining: 1,
        unlimitedActivations: true,
        initialSeconds: 40,
        baseSeconds: 40,
        dbConsumedSeconds: 0,
      },
    });
    expect(claimMovedPresence(PLAYER, MAIN2)!.timeBank).toEqual({
      remainingSeconds: 11,
      usesRemaining: 1,
      unlimitedActivations: true,
      initialSeconds: 40,
      baseSeconds: 40,
      dbConsumedSeconds: 0,
    });
  });
});

describe('the wiring, so the handoff cannot be left unplugged', () => {
  const BASE = read('./ServerTableEngineBase.ts');
  const DEALING = read('./ServerTableEngineDealing.ts');

  it('the source deposits before it forgets the player', () => {
    const at = BASE.indexOf('this.depositPresenceForMove(m.player_id, m.to_table_id);');
    const forget = BASE.indexOf(
      'this.disconnectEngine.unregisterPlayer(this.tableId, m.player_id);'
    );
    expect(at).toBeGreaterThan(0);
    expect(forget).toBeGreaterThan(at);
  });

  it('a swap side that never runs an executor still deposits, from the announce', () => {
    expect(BASE).toMatch(
      /for \(const m of pending\) \{[\s\S]{0,700}?this\.depositPresenceForMove\(m\.player_id, m\.to_table_id\)/
    );
  });

  it('BOTH seat sweeps adopt BEFORE restoreSitOutsFromSeats', () => {
    // Order is load-bearing: restoreSitOutsFromSeats registers the player, and
    // restoreFsmStates refuses to clobber a live entry, so registering first
    // would throw away everything the move carried.
    for (const src of [BASE, DEALING]) {
      const adoptAt = src.indexOf('this.adoptMovedPresence();');
      const restoreAt = src.indexOf('this.restoreSitOutsFromSeats();');
      expect(adoptAt).toBeGreaterThan(0);
      expect(restoreAt).toBeGreaterThan(adoptAt);
    }
  });

  it('the executors carry the sit-out instead of resetting it', () => {
    const sql = readFileSync(
      resolve(
        __dirname,
        '../../../supabase/migrations/20260905064237_horses_use_the_seat_change_and_presence_follows_the_move.sql'
      ),
      'utf8'
    );
    // The old line, in either executor, is the bug.
    expect(sql).not.toMatch(/is_sitting_out = false, sit_out_at = NULL/);
    expect(sql).toMatch(
      /is_sitting_out = coalesce\(src\.is_sitting_out, false\), sit_out_at = src\.sit_out_at/
    );
    expect(sql).toMatch(
      /is_sitting_out = coalesce\(a\.is_sitting_out, false\), sit_out_at = a\.sit_out_at/
    );
    expect(sql).toMatch(
      /is_sitting_out = coalesce\(b\.is_sitting_out, false\), sit_out_at = b\.sit_out_at/
    );
    // And nothing about chips or entry state moved with it.
    expect(sql).toMatch(
      /v_hold := CASE WHEN m\.reason = 'seat_change' THEN 'waiting' ELSE 'moved' END/
    );
    expect(sql).toMatch(/v_agreed := \(m\.reason = 'seat_change'\)/);
    expect(sql).toMatch(/v_stack := src\.stack;/);
  });
});
