/**
 * PRESENCE DOES NOT OUTLIVE THE SEAT (2026-10-04, timeout and reconnect audit).
 *
 * The presence FSM mirrors the seats of one table. A tournament departure and
 * a restart both left entries behind for players who no longer sat there, the
 * hourly park wrote them back, and a returning player inherited them whole.
 * Production, 2026-10-04: 473 of 2,849 parked entries were DISCONNECTED or
 * MISSING horses, which a seated horse never is (the engine heartbeats it).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DisconnectEngine, type DisconnectFsmEntry } from './DisconnectEngine.js';
import { PreciseActionTimer } from './PreciseActionTimer.js';
import { ServerTableEngine } from './ServerTableEngine.js';

const TABLE = 'bbbbbbbb-1234-4321-9876-bbbbbbbbbbbb';
const timers: PreciseActionTimer[] = [];
const engines: any[] = [];

afterEach(() => {
  timers.splice(0).forEach((t) => t.dispose());
  for (const engine of engines.splice(0)) {
    engine.disconnectEngine.disposeAll();
    engine.preciseTimer.dispose();
  }
  vi.restoreAllMocks();
});

function presence() {
  const timer = new PreciseActionTimer();
  timers.push(timer);
  return { timer, fsm: new DisconnectEngine(timer) };
}

function tableEngine(tableInfo: Record<string, unknown>) {
  const engine = new ServerTableEngine(TABLE) as any;
  engines.push(engine);
  engine.running = true;
  engine.isCurrentEngine = () => true;
  engine.tableInfo = tableInfo;
  return engine;
}

const seat = (userId: string, seatNumber: number) => ({
  user_id: userId,
  seat_number: seatNumber,
  occupancy_id: `occ-${userId}`,
});

const satOutYesterday: DisconnectFsmEntry = {
  state: 'SAT_OUT',
  sinceMs: Date.now() - 23 * 3_600_000,
  graceDeadlineMs: null,
  sitOutSinceMs: Date.now() - 23 * 3_600_000,
  sitOutReason: 'forced',
  strikes: 3,
};

describe('DisconnectEngine.retainOnly', () => {
  it('forgets every player of the table who is not seated, and only those', () => {
    const { fsm, timer } = presence();
    fsm.registerPlayer(TABLE, 'stays');
    fsm.registerPlayer(TABLE, 'moved-away');
    fsm.registerPlayer('another-table', 'moved-away');
    fsm.markDisconnected(TABLE, 'moved-away');
    fsm.onPlayerTurn(TABLE, 'moved-away', true);
    expect(timer.hasTimer(TABLE, 'disconnect:moved-away')).toBe(true);

    expect(fsm.retainOnly(TABLE, ['stays'])).toEqual(['moved-away']);

    expect(Object.keys(fsm.getFsmStatesForTable(TABLE))).toEqual(['stays']);
    expect(timer.hasTimer(TABLE, 'disconnect:moved-away')).toBe(false);
    expect(fsm.getState('another-table', 'moved-away')).not.toBeNull();
  });

  it('closes an open transport window for a forgotten player', () => {
    vi.useFakeTimers();
    try {
      const { fsm } = presence();
      const events: string[] = [];
      const withEvents = new DisconnectEngine(new PreciseActionTimer(), (e) => events.push(e.type));
      withEvents.registerPlayer(TABLE, 'gone');
      withEvents.markTransportGone(TABLE, 'gone');
      withEvents.retainOnly(TABLE, []);
      vi.advanceTimersByTime(60_000);
      expect(events).toEqual([]);
      void fsm;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe.each([
  ['tournament', { tournament_id: 'cccccccc-1234-4321-9876-cccccccccccc' }],
  ['cash', { game_type: 'cash' }],
])('a %s roster is the authority on presence', (_format, tableInfo) => {
  it('a player who left this table leaves no presence entry behind', () => {
    const engine = tableEngine(tableInfo);
    engine.seatedPlayers = [seat('stays', 1), seat('leaves', 2)];
    engine.disconnectEngine.registerPlayer(TABLE, 'stays');
    engine.disconnectEngine.registerPlayer(TABLE, 'leaves');

    engine.adoptSeatRoster([seat('stays', 1)]);

    expect(Object.keys(engine.disconnectEngine.getFsmStatesForTable(TABLE))).toEqual(['stays']);
  });

  it('a parked entry restored for somebody no longer seated is dropped, not parked again', () => {
    const engine = tableEngine(tableInfo);
    engine.disconnectEngine.restoreFsmStates(TABLE, {
      stays: { state: 'CONNECTED', sinceMs: Date.now(), graceDeadlineMs: null },
      ghost: satOutYesterday,
    });

    engine.adoptSeatRoster([seat('stays', 1)]);

    expect(Object.keys(engine.captureRetainedPresence())).toEqual(['stays']);
  });

  it('a player who returns to a table they once left starts clean', () => {
    const engine = tableEngine(tableInfo);
    engine.disconnectEngine.restoreFsmStates(TABLE, { returns: satOutYesterday });
    engine.adoptSeatRoster([seat('stays', 1)]);

    engine.adoptSeatRoster([seat('stays', 1), seat('returns', 2)]);
    engine.disconnectEngine.registerPlayer(TABLE, 'returns');

    expect(engine.disconnectEngine.isSittingOut(TABLE, 'returns')).toBe(false);
    expect(engine.disconnectEngine.getState(TABLE, 'returns')).toMatchObject({
      isConnected: true,
      consecutiveTimeouts: 0,
    });
    expect(engine.disconnectEngine.tickSitOutsAndCollectEvictions(TABLE, ['returns'])).toEqual([]);
  });
});
