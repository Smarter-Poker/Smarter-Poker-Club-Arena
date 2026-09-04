/**
 * ABANDONED SEATS — the disconnect audit's first finding (2026-09-04)
 *
 * A player who is gone but never sat out fell through every eviction rule at
 * a quiet table: the sit-out clock needs `isSittingOut`, the away-blind cap
 * needs blinds to be charged, the forced sit-out needs three turns. Below the
 * deal minimum none of those happen, so a dead phone held its seat and chips
 * forever. Dan's sit-out rule ("5 minutes") now covers a seat nobody is
 * behind, measured from the moment the engine concluded they were gone.
 *
 * As with the blind cap, most of these pin the case where it must NOT fire.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { DisconnectEngine } from './DisconnectEngine.js';
import { PreciseActionTimer } from './PreciseActionTimer.js';

const TABLE = 'table-1';
const PLAYER = 'player-1';
const FIVE_MIN = DisconnectEngine.SITOUT_MAX_MS;

describe('abandoned-seat eviction', () => {
  let eng: DisconnectEngine;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-04T12:00:00Z'));
    eng = new DisconnectEngine(new PreciseActionTimer());
    eng.registerPlayer(TABLE, PLAYER);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('never touches a connected player, however long the table sits idle', () => {
    vi.advanceTimersByTime(FIVE_MIN * 3);
    expect(eng.collectAbandonedSeatEvictions(TABLE, [PLAYER])).toEqual([]);
  });

  it('does not fire before five minutes', () => {
    eng.markDisconnected(TABLE, PLAYER);
    vi.advanceTimersByTime(FIVE_MIN - 1000);
    expect(eng.collectAbandonedSeatEvictions(TABLE, [PLAYER])).toEqual([]);
  });

  it('fires at five minutes for a DISCONNECTED player', () => {
    eng.markDisconnected(TABLE, PLAYER);
    vi.advanceTimersByTime(FIVE_MIN);
    expect(eng.collectAbandonedSeatEvictions(TABLE, [PLAYER])).toEqual([PLAYER]);
  });

  it('fires at five minutes after an /away beacon (page left)', () => {
    eng.markPageLeft(TABLE, PLAYER);
    vi.advanceTimersByTime(FIVE_MIN);
    expect(eng.collectAbandonedSeatEvictions(TABLE, [PLAYER])).toEqual([PLAYER]);
  });

  it('a heartbeat before the sweep cancels it: presence wins at the moment of decision', () => {
    eng.markDisconnected(TABLE, PLAYER);
    vi.advanceTimersByTime(FIVE_MIN + 5000);
    eng.heartbeat(TABLE, PLAYER);
    expect(eng.collectAbandonedSeatEvictions(TABLE, [PLAYER])).toEqual([]);
  });

  it('leaves a sat-out player to the sit-out rule', () => {
    eng.sitOut(TABLE, PLAYER, 'voluntary');
    eng.markDisconnected(TABLE, PLAYER);
    vi.advanceTimersByTime(FIVE_MIN * 2);
    expect(eng.collectAbandonedSeatEvictions(TABLE, [PLAYER])).toEqual([]);
    // ...which does fire, on its own clock.
    expect(eng.tickSitOutsAndCollectEvictions(TABLE, [PLAYER])).toEqual([PLAYER]);
  });

  it('ignores a player the engine is not tracking', () => {
    expect(eng.collectAbandonedSeatEvictions(TABLE, ['nobody'])).toEqual([]);
  });
});
