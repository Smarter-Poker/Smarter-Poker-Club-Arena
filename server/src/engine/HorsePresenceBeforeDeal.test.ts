import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ServerTableEngine } from './ServerTableEngine.js';

vi.mock('../services/supabase/client.js', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
  maintenanceSupabase: {},
}));

const TABLE = 'aaaa2244-1111-4111-8111-111111111111';
const PLAYER = 'restored-player';
const engines: any[] = [];

function restoredEngine(horse: boolean, state: 'CONNECTED' | 'DISCONNECTED' | 'SAT_OUT') {
  const engine = new ServerTableEngine(TABLE) as any;
  engines.push(engine);
  const seat = { user_id: PLAYER, seat_number: 1, stack: 100, is_horse: horse };
  engine.running = true;
  engine.isCurrentEngine = () => true;
  engine.tableInfo = { id: TABLE, tournament_id: 'fixture-event', max_players: 2 };
  engine.seatedPlayers = [seat];
  engine.knownPlayerIds.add(PLAYER);
  engine.dealingLoopFirstIteration = false;
  engine.prepareNextHand = vi.fn(async () => [{ ...seat }]);
  engine.adoptMovedPresence = vi.fn();
  engine.restoreSitOutsFromSeats = vi.fn();
  engine.evictExpiredSitOuts = vi.fn(async () => {});
  // Stop after the real roster/presence boundary, before dealing or database
  // work. No heartbeat scheduler is running in this recovered-table fixture.
  engine.adminPauseLock = true;
  engine.sleep = vi.fn(async () => {
    engine.running = false;
  });
  engine.disconnectEngine.configure(TABLE, { disconnectTimeoutSeconds: 30 });
  engine.disconnectEngine.restoreFsmStates(TABLE, {
    [PLAYER]: {
      state,
      sinceMs: Date.now() - 180_000,
      graceDeadlineMs: state === 'DISCONNECTED' ? Date.now() - 150_000 : null,
      reconnectDeadlineMs: state === 'DISCONNECTED' ? Date.now() - 150_000 : undefined,
      strikes: 2,
      sitOutReason: state === 'SAT_OUT' ? 'voluntary' : undefined,
      sitOutSinceMs: state === 'SAT_OUT' ? Date.now() - 120_000 : undefined,
      sitOutOrbits: 1,
    },
  });
  engine.timeBankEngine.configure(TABLE, { secondsPerUse: 20 });
  engine.timeBankEngine.initializePlayer(TABLE, PLAYER, { remainingSeconds: 20, usesRemaining: 1 });
  return engine;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_800_000_000_000);
});
afterEach(() => {
  for (const engine of engines.splice(0)) {
    engine.disconnectEngine.unregisterPlayer(TABLE, PLAYER);
    engine.timeBankEngine.dispose(TABLE);
    engine.preciseTimer.dispose();
  }
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('restored horse presence is observed before the first deal', () => {
  it.each(['CONNECTED', 'DISCONNECTED'] as const)(
    'refreshes a %s horse before the stale check can force a turn',
    async (state) => {
      const engine = restoredEngine(true, state);
      const autoAction = vi.fn();
      engine.disconnectEngine.onAutoAction(TABLE, autoAction);
      await engine.dealingLoop();
      expect(engine.disconnectEngine.isConnected(TABLE, PLAYER)).toBe(true);
      engine.disconnectEngine.onPlayerTurn(TABLE, PLAYER, false);
      await vi.advanceTimersByTimeAsync(200);
      expect(autoAction).not.toHaveBeenCalled();
      expect(engine.disconnectEngine.isSittingOut(TABLE, PLAYER)).toBe(false);
      expect(engine.disconnectEngine.getState(TABLE, PLAYER).consecutiveTimeouts).toBe(
        state === 'CONNECTED' ? 2 : 0
      );
      expect(engine.timeBankEngine.getUsesRemaining(TABLE, PLAYER)).toBe(1);
    }
  );

  it.each(['CONNECTED', 'DISCONNECTED'] as const)(
    'still marks a stale %s human disconnected and preserves existing protection',
    async (state) => {
      const engine = restoredEngine(false, state);
      const deadline = engine.disconnectEngine.getFsmState(TABLE, PLAYER).reconnectDeadlineMs;
      await engine.dealingLoop();
      expect(engine.disconnectEngine.isConnected(TABLE, PLAYER)).toBe(false);
      if (deadline !== undefined)
        expect(engine.disconnectEngine.getFsmState(TABLE, PLAYER).reconnectDeadlineMs).toBe(
          deadline
        );
      expect(engine.disconnectEngine.getState(TABLE, PLAYER).consecutiveTimeouts).toBe(2);
    }
  );

  it('preserves a voluntary horse sit-out, its eviction clock, strikes and remaining bank', async () => {
    const engine = restoredEngine(true, 'SAT_OUT');
    const before = engine.disconnectEngine.getFsmState(TABLE, PLAYER);
    await engine.dealingLoop();
    const after = engine.disconnectEngine.getFsmState(TABLE, PLAYER);
    expect(after.state).toBe('SAT_OUT');
    expect(after.sitOutReason).toBe('voluntary');
    expect(after.sitOutSinceMs).toBe(before.sitOutSinceMs);
    expect(after.sitOutOrbits).toBe(1);
    expect(after.strikes).toBe(2);
    expect(engine.timeBankEngine.getUsesRemaining(TABLE, PLAYER)).toBe(1);
  });

  it('does not refresh an unaccepted roster after the engine loses authority', async () => {
    const engine = restoredEngine(true, 'DISCONNECTED');
    const originalRoster = engine.seatedPlayers;
    engine.prepareNextHand = vi.fn(async () => {
      engine.running = false;
      return engine.seatedPlayers.map((seat: object) => ({ ...seat }));
    });
    const before = engine.disconnectEngine.getFsmState(TABLE, PLAYER);
    await engine.dealingLoop();
    expect(engine.seatedPlayers).toBe(originalRoster);
    expect(engine.adoptMovedPresence).not.toHaveBeenCalled();
    expect(engine.restoreSitOutsFromSeats).not.toHaveBeenCalled();
    expect(engine.disconnectEngine.getFsmState(TABLE, PLAYER)).toEqual(before);
  });
});
