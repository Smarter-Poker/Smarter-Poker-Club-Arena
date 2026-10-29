import { afterEach, expect, it, vi } from 'vitest';
vi.mock('../services/supabase/client.js', () => ({
  supabase: {
    from: () => {
      throw Error('Unexpected SQL');
    },
    rpc: () => {
      throw Error('Unexpected RPC');
    },
  },
  maintenanceSupabase: {},
}));
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn(), reportWarning: vi.fn() }));
import { ServerTableEngine } from './ServerTableEngine.js';
import { HandController } from './HandController.js';
import { encodePrivateHandContinuation } from './PrivateHandContinuation.js';
function gate() {
  let resolve!: () => void, reject!: (e: unknown) => void;
  const promise = new Promise<void>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
const held: any[] = [];
function fixture(n: number) {
  const tableId = `c0ffee00-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const e: any = new ServerTableEngine(tableId);
  held.push(e);
  expect(e.claimProcessOwnership()).toBe(true);
  e.running = true;
  e.handCount = 42;
  e.tableInfo = {
    id: tableId,
    tournament_id: 'c0ffee00-0000-4000-8000-111111111111',
    small_blind: 10,
    big_blind: 20,
    ante: 0,
  };
  e.engineLeaseScope = 'tournament';
  e.engineLeaseTournamentId = e.tableInfo.tournament_id;
  const players = [1, 2].map((seat) => ({
    seat,
    user_id: 'user' + seat,
    username: 'Player' + seat,
    stack: 1000,
    bet: 0,
    totalInvested: 0,
    cards: [],
    is_folded: false,
    is_all_in: false,
    is_sitting_out: false,
  }));
  const controller = new HandController(
    {
      tableId,
      handNumber: 42,
      gameVariant: 'nlh',
      smallBlind: 10,
      bigBlind: 20,
      ante: 0,
      isTournament: true,
      rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
    },
    players,
    1
  );
  controller.start();
  e.handController = controller;
  e.seatedPlayers = players.map((p) => ({
    ...p,
    seat_number: p.seat,
    seat_id: `c0ffee00-0000-4000-8000-${String(n * 10 + p.seat).padStart(12, '0')}`,
    seat_joined_at: '2026-10-29T00:00:00Z',
    occupancy_id: `c0ffee00-0000-4000-8000-${String(n * 100 + p.seat).padStart(12, '0')}`,
  }));
  for (const p of players) {
    e.timeBankEngine.initializePlayer(tableId, p.user_id);
    e.timeBankMeta.set(p.user_id, { initialSeconds: 40, baseSeconds: 40, dbConsumedSeconds: 0 });
  }
  const original: any = {
    version: 1,
    original: {
      tournament_id: e.tableInfo.tournament_id,
      table_id: tableId,
      hand_number: '42',
      permit_id: `c0ffee00-0000-4000-8000-${String(n + 500).padStart(12, '0')}`,
      lease_generation: 'c0ffee00-0000-4000-8000-222222222222',
      lifecycle: '1',
      custody_id: 'c0ffee00-0000-4000-8000-333333333333',
    },
    seats: e.seatedPlayers.map((s: any) => ({
      user_id: s.user_id,
      seat_id: s.seat_id,
      seat_joined_at: s.seat_joined_at,
      stack_before: s.stack,
    })),
    batch: {
      version: 1,
      sequence: 3,
      controller: controller.serializeRecoveryState(),
      events: [],
      engine: e.captureContinuationEngine(),
    },
  };
  e.pendingOriginalContinuation = original;
  e.handContinuation = null;
  e.flushSnapshot = vi.fn(async () => {});
  return { e, controller, original, durable: encodePrivateHandContinuation(original) };
}
afterEach(() => {
  for (const e of held.splice(0)) {
    e.running = false;
    e.preciseTimer.dispose();
    e.engineTelemetry.dispose();
    (ServerTableEngine as any).releaseCurrentEngine(e.tableId, e);
  }
});
it('exact EED stop fences all four and joins physical writers without changing retained envelopes', async () => {
  const f = [1, 2, 3, 4].map(fixture);
  const writers = f.map(() => gate());
  let done = false;
  f.forEach(({ e }, i) => {
    e.dealingLoopPromise = writers[i].promise;
  });
  const stop = Promise.all(f.map(({ e }) => e.stop())).then(() => {
    done = true;
  });
  for (const { e, controller } of f) {
    expect(e.running).toBe(false);
    expect(e.terminal).toBe(true);
    expect(e.handController).toBe(controller);
  }
  writers.slice(0, 3).forEach((g) => g.resolve());
  await Promise.resolve();
  await Promise.resolve();
  expect(done).toBe(false);
  writers[3].resolve();
  await stop;
  for (const { e, original, durable, controller } of f) {
    expect(encodePrivateHandContinuation(original)).toEqual(durable);
    expect(controller.serializeRecoveryState()).toBe(original.batch.controller);
    expect(e.pendingOriginalContinuation).toBe(original);
    expect(e.handController).toBeNull();
    expect(e.terminalTeardownComplete).toBe(true);
    expect(e.hasReleasedProcessOwnership()).toBe(true);
    expect(e.hasUnretiredStoppedTimeBankCustody()).toBe(true);
    expect(Object.keys(e.stoppedTimeBankCustody.banks)).toHaveLength(2);
  }
});
it('exact EED partial stop clears its HC but must retain unknown bank custody and the captured original owner', async () => {
  const { e, controller, original, durable } = fixture(5);
  const write = gate();
  e.presenceSavePending = 1;
  e.presenceSave = write.promise;
  const stopping = e.stop();
  const rejected = expect(stopping).rejects.toThrow('teardown failed');
  write.reject(Error('unknown original bank acknowledgement'));
  await rejected;
  expect(e.handController).toBeNull();
  expect(e.terminalTeardownComplete).toBe(false);
  expect(e.terminalTeardownDrained).toBe(true);
  expect(e.hasUnretiredStoppedTimeBankCustody()).toBe(true);
  expect(e.pendingOriginalContinuation).toBe(original);
  expect(encodePrivateHandContinuation(original)).toEqual(durable);
  expect(controller.serializeRecoveryState()).toBe(original.batch.controller);
});
it('a pre-actuation mutation differs from the durable private original before any stop', () => {
  const { e, controller, original } = fixture(6);
  const state = controller.getState();
  expect(controller.performAction(state.currentPlayerSeat, 'fold')).toBe(true);
  expect(controller.serializeRecoveryState()).not.toBe(original.batch.controller);
  expect(e.running).toBe(true);
  expect(e.handController).toBe(controller);
});
