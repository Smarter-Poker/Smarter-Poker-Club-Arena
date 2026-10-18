/**
 * A WAITING TABLE STILL ASKS WHO IS THERE (launch audit 2026-10-05).
 *
 * Presence was judged only by the heartbeat tick, which is armed after the
 * start-up wait loop breaks. A cash table below its deal minimum never left
 * that loop, so a human restored as CONNECTED after the hourly restart was
 * never asked again and held the seat and the stack indefinitely.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ServerTableEngine } from './ServerTableEngine.js';
import { setMaintenanceFrozen } from '../maintenance/freezeState.js';

vi.mock('../services/supabase/client.js', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
  maintenanceSupabase: {},
}));

const TABLE = 'aaaa2244-2222-4222-8222-222222222222';
const HUMAN = 'human-who-walked-away';
const HORSE = 'horse-with-no-browser';
const engines: any[] = [];

function waitingCashEngine() {
  const engine = new ServerTableEngine(TABLE) as any;
  engines.push(engine);
  engine.running = true;
  engine.tableInfo = { id: TABLE, tournament_id: null, max_players: 6 };
  engine.seatedPlayers = [
    { user_id: HUMAN, seat_number: 1, stack: 100, is_horse: false },
    { user_id: HORSE, seat_number: 2, stack: 100, is_horse: true },
  ];
  engine.chipContinuity = { sweepPresence: vi.fn(async () => {}) };
  engine.releaseLeavesHeldByClock = vi.fn(async () => {});
  engine.disconnectEngine.configure(TABLE, { disconnectTimeoutSeconds: 30 });
  return engine;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_800_000_000_000);
});
afterEach(() => {
  setMaintenanceFrozen(false);
  for (const engine of engines.splice(0)) {
    engine.disconnectEngine.dispose(TABLE);
    engine.preciseTimer.dispose();
  }
  vi.useRealTimers();
});

describe('a waiting table still asks who is there', () => {
  it('a restarted Lightning anchor supplies presence while ordinary dealing stays halted', async () => {
    const engine = waitingCashEngine();
    engine.isCurrentEngine = () => true;
    engine.tableInfo.cluster_id = 'private-lightning-cluster';
    engine.dealingHaltLock = true;
    engine.observeDealingHalt = vi.fn(async () => {});
    engine.stopIfClusterTableClosed = vi.fn(async () => {});
    expect(engine.lightningPresenceReport().players.map((p: any) => p.presence)).toEqual([
      'unknown',
      'unknown',
    ]);

    await engine.passWhileDealingHalted();
    expect(engine.lightningPresenceReport().players.map((p: any) => p.presence)).toEqual([
      'connected',
      'connected',
    ]);
    vi.advanceTimersByTime(31_000);
    await engine.passWhileDealingHalted();
    expect(engine.lightningPresenceReport().players.map((p: any) => p.presence)).toEqual([
      'disconnected',
      'connected',
    ]);
    expect(engine.dealingHaltLock).toBe(true);
    expect(engine.seatedPlayers.map((p: any) => p.stack)).toEqual([100, 100]);
    expect(engine.chipContinuity.sweepPresence).not.toHaveBeenCalled();
    expect(engine.releaseLeavesHeldByClock).not.toHaveBeenCalled();
  });

  it('a halted anchor preserves a voluntary sit-out and its original clock', async () => {
    const engine = waitingCashEngine();
    engine.isCurrentEngine = () => true;
    engine.tableInfo.cluster_id = 'private-lightning-cluster';
    engine.observeDealingHalt = vi.fn(async () => {});
    engine.stopIfClusterTableClosed = vi.fn(async () => {});
    const since = Date.now() - 240_000;
    engine.seatedPlayers[1].is_sitting_out = true;
    engine.seatedPlayers[1].sit_out_at = new Date(since).toISOString();
    await engine.passWhileDealingHalted();
    vi.advanceTimersByTime(60_000);
    await engine.passWhileDealingHalted();
    expect(engine.disconnectEngine.isSittingOut(TABLE, HORSE)).toBe(true);
    expect(engine.disconnectEngine.getFsmState(TABLE, HORSE)?.sitOutSinceMs).toBe(since);
    expect(engine.seatedPlayers).toHaveLength(2);
  });

  it('a halted anchor leaves presence untouched during the maintenance freeze', async () => {
    const engine = waitingCashEngine();
    engine.isCurrentEngine = () => true;
    engine.observeDealingHalt = vi.fn(async () => {});
    engine.stopIfClusterTableClosed = vi.fn(async () => {});
    setMaintenanceFrozen(true);
    await engine.passWhileDealingHalted();
    expect(
      engine.lightningPresenceReport().players.every((p: any) => p.presence === 'unknown')
    ).toBe(true);
  });

  it('concludes a silent human is gone, and the five-minute rule then finds them', async () => {
    const engine = waitingCashEngine();
    await engine.judgePresenceWhileWaiting();
    // A fresh entry starts connected with a full timeout ahead of it.
    expect(engine.disconnectEngine.isConnected(TABLE, HUMAN)).toBe(true);

    vi.advanceTimersByTime(31_000);
    await engine.judgePresenceWhileWaiting();
    expect(engine.disconnectEngine.isConnected(TABLE, HUMAN)).toBe(false);
    expect(engine.disconnectEngine.collectAbandonedSeatEvictions(TABLE, [HUMAN, HORSE])).toEqual(
      []
    );

    vi.advanceTimersByTime(5 * 60_000);
    await engine.judgePresenceWhileWaiting();
    expect(engine.disconnectEngine.collectAbandonedSeatEvictions(TABLE, [HUMAN, HORSE])).toEqual([
      HUMAN,
    ]);
    expect(engine.chipContinuity.sweepPresence).toHaveBeenCalledTimes(3);
    expect(engine.releaseLeavesHeldByClock).toHaveBeenCalledTimes(3);
  });

  it('a human whose client keeps beating is never judged gone', async () => {
    const engine = waitingCashEngine();
    await engine.judgePresenceWhileWaiting();
    for (let i = 0; i < 80; i++) {
      vi.advanceTimersByTime(5_000);
      engine.disconnectEngine.heartbeat(TABLE, HUMAN);
      await engine.judgePresenceWhileWaiting();
    }
    expect(engine.disconnectEngine.isConnected(TABLE, HUMAN)).toBe(true);
    expect(engine.disconnectEngine.collectAbandonedSeatEvictions(TABLE, [HUMAN])).toEqual([]);
  });

  it('a horse gets the same synthetic beat the tick gives it, however long the pass took', async () => {
    const engine = waitingCashEngine();
    await engine.judgePresenceWhileWaiting();
    vi.advanceTimersByTime(10 * 60_000);
    await engine.judgePresenceWhileWaiting();
    expect(engine.disconnectEngine.isConnected(TABLE, HORSE)).toBe(true);
  });

  it('stands down once the heartbeat tick owns presence, and on a tournament table', async () => {
    const engine = waitingCashEngine();
    engine.heartbeatActive = true;
    await engine.judgePresenceWhileWaiting();
    expect(engine.chipContinuity.sweepPresence).not.toHaveBeenCalled();

    const event = waitingCashEngine();
    event.tableInfo = { id: TABLE, tournament_id: 'fixture-event', max_players: 6 };
    await event.judgePresenceWhileWaiting();
    expect(event.chipContinuity.sweepPresence).not.toHaveBeenCalled();
  });

  it('the wait loop asks after presence is adopted and before the eviction reads it', () => {
    const src = readFileSync(resolve(__dirname, 'ServerTableEngineBase.ts'), 'utf8');
    const adopt = src.indexOf('if (!(await this.adoptMovedPresence())) {');
    const judge = src.indexOf('await this.judgePresenceWhileWaiting();');
    const evict = src.indexOf('await this.evictExpiredSitOuts({ countOrbit: false }).catch(');
    expect(adopt).toBeGreaterThan(-1);
    expect(judge).toBeGreaterThan(adopt);
    expect(evict).toBeGreaterThan(judge);
  });
});
