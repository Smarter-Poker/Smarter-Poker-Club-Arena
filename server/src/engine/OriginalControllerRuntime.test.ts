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
import type { HandConfig, HandEvent, SeatPlayer } from '../types.js';
const config: HandConfig = {
  tableId: 'cccccccc-0000-4000-8000-0000000000a1',
  handNumber: 42,
  gameVariant: 'nlh',
  smallBlind: 10,
  bigBlind: 20,
  ante: 0,
  isTournament: true,
  rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
};
const players: SeatPlayer[] = [1, 2].map((seat) => ({
  seat,
  user_id: 'u' + seat,
  username: 'P' + seat,
  stack: 1000,
  bet: 0,
  totalInvested: 0,
  cards: [],
  is_folded: false,
  is_all_in: false,
  is_sitting_out: false,
}));
const binding = {
  tournament_id: 'aaaaaaaa-0000-4000-8000-0000000000a1',
  table_id: config.tableId,
  hand_number: '42',
  permit_id: 'dddddddd-0000-4000-8000-0000000000a1',
  lease_generation: 'bbbbbbbb-0000-4000-8000-0000000000a1',
  lifecycle: '1',
  custody_id: 'eeeeeeee-0000-4000-8000-0000000000a1',
};
const engines: any[] = [];
afterEach(() => {
  for (const e of engines.splice(0)) {
    e.running = false;
    e.activeHandWaitRelease?.release('test_cleanup');
    e.handContinuation?.close();
    (ServerTableEngine as any).releaseCurrentEngine(e.tableId, e);
    e.preciseTimer.dispose();
    e.engineTelemetry.dispose();
  }
  vi.restoreAllMocks();
});
function fixture() {
  const e: any = new ServerTableEngine(config.tableId);
  engines.push(e);
  expect(e.claimProcessOwnership()).toBe(true);
  e.running = true;
  e.handCount = 42;
  e.lifecycleCanMutate = () => true;
  e.handController = new HandController(config, players, 1);
  e.currentHandSeatGenerations = new Map(
    players.map((p) => [
      p.user_id,
      {
        seat_id: '00000000-0000-4000-8000-00000000000' + p.seat,
        seat_joined_at: '2026-10-28T00:00:00Z',
      },
    ])
  );
  e.currentHandDealtStacks = new Map(players.map((p) => [p.user_id, p.stack]));
  e.f06CurrentPermit = {
    binding,
    assertPreparedStartAllowed: () => {},
    attemptOriginalRetention: () => {},
    start: (f: () => void) => f(),
  };
  e.acquireFinancialControllerStart = async () => null;
  e.beginTerminalBoundaryPersistence = () => 1;
  e.flushSnapshot = async () => {};
  e.dispatchFinancialHandComplete = (f: () => Promise<void>) => f();
  e.clearTurnTimer = () => {};
  const emitted: HandEvent[] = [];
  e.handleHandEvent = async (event: HandEvent) => {
    emitted.push(event);
  };
  e.killForRestart = vi.fn();
  const roster = players.map((p) => ({ user_id: p.user_id, seat_number: p.seat, stack: p.stack }));
  return { e, emitted, roster };
}
it('retains the prepared deck and every actual controller mutation before its original consumer', async () => {
  const { e, emitted, roster } = fixture();
  const writes: any[] = [];
  let release!: (() => void) | undefined;
  e.retainOriginalBatch = async (_o: unknown, _s: unknown, b: any) => {
    writes.push(structuredClone(b));
    if (b.sequence > 0)
      await new Promise<void>((r) => {
        release = r;
      });
  };
  const controller = e.handController;
  const started = e.runOriginalController(roster, controller, 42, Date.now(), {
    started: false,
    cause: null,
  });
  await vi.waitFor(() => expect(writes.length).toBe(2));
  expect(writes[0].sequence).toBe(0);
  expect(JSON.parse(writes[0].controller).handStarted).toBe(false);
  expect(emitted).toEqual([]);
  expect(e.getActionContext()).toBeNull();
  release!();
  await e.handContinuation.join();
  expect(emitted.some((x) => x.type === 'CARDS_DEALT')).toBe(true);
  expect(e.getActionContext()).toBeTruthy();
  const before = emitted.length;
  const s = controller.getState();
  expect(controller.performAction(s.currentPlayerSeat, 'fold')).toBe(true);
  await vi.waitFor(() => expect(writes.length).toBe(3));
  expect(emitted.length).toBe(before);
  expect(JSON.parse(writes[2].controller).handCompleted).toBe(true);
  release!();
  await started;
  await e.handContinuation.join();
  expect(emitted.filter((x) => x.type === 'HAND_COMPLETE')).toHaveLength(1);
  expect(e.killForRestart).not.toHaveBeenCalled();
});
it('replays an original terminal batch without another start, deal, or controller payout', async () => {
  const { e, emitted, roster } = fixture();
  const original: HandController = e.handController;
  const terminal: HandEvent[] = [];
  original.onEvent((x: HandEvent) => terminal.push(x));
  original.start();
  original.performAction(original.getState().currentPlayerSeat, 'fold');
  const encoded = original.serializeRecoveryState();
  const restored = HandController.fromRecoveryState(encoded, config.tableId, 42);
  e.handController = restored;
  e.pendingOriginalContinuation = {
    version: 1,
    original: binding,
    seats: roster.map((p) => ({
      ...p,
      seat_id: 'x',
      seat_joined_at: '2026-10-28T00:00:00Z',
      stack_before: 1000,
    })),
    batch: {
      version: 1,
      sequence: 2,
      controller: encoded,
      events: terminal.filter((x) => ['WINNERS', 'HAND_COMPLETE'].includes(x.type)),
      engine: { fields: {} },
    },
  };
  e.retainOriginalBatch = vi.fn();
  const start = vi.spyOn(restored, 'start');
  const stacks = restored.getState().players.map((p) => p.stack);
  await e.runOriginalController(roster, restored, 42, Date.now(), { started: true, cause: null });
  await e.handContinuation.join();
  expect(start).not.toHaveBeenCalled();
  expect(e.retainOriginalBatch).not.toHaveBeenCalled();
  expect(emitted.filter((x) => x.type === 'HAND_COMPLETE')).toHaveLength(1);
  expect(emitted.some((x) => x.type === 'CARDS_DEALT')).toBe(false);
  expect(restored.getState().players.map((p) => p.stack)).toEqual(stacks);
});

it('continues the saved all-in hand with the same cards and payout through the original runner', async () => {
  const { e, emitted, roster } = fixture();
  const original: HandController = e.handController;
  original.start();
  expect(original.performAction(original.getState().currentPlayerSeat, 'all_in')).toBe(true);
  const saved = original.serializeRecoveryState();
  const restored = HandController.fromRecoveryState(saved, config.tableId, 42);
  const deck = restored.getRemainingDeck();
  const complete = (c: HandController) => {
    for (let n = 0; n < 30 && c.getState().stage !== 'showdown'; n++) {
      const s = c.getState();
      if (s.currentPlayerSeat < 0) c.continueRunout();
      else {
        const p = s.players.find((p) => p.seat === s.currentPlayerSeat)!;
        expect(c.performAction(p.seat, p.bet < s.currentBet ? 'call' : 'check')).toBe(true);
      }
    }
  };
  complete(original);
  const expected = original.getState().players.map((p) => p.stack);
  e.handController = restored;
  e.pendingOriginalContinuation = {
    version: 1,
    original: binding,
    seats: roster.map((p) => ({
      ...p,
      seat_id: 's',
      seat_joined_at: '2026-10-28T00:00:00Z',
      stack_before: 1000,
    })),
    batch: { version: 1, sequence: 7, controller: saved, events: [], engine: { fields: {} } },
  };
  const writes: any[] = [];
  e.retainOriginalBatch = async (_o: unknown, _s: unknown, b: any) => {
    writes.push(structuredClone(b));
  };
  const resumed = e.runOriginalController(roster, restored, 42, Date.now(), {
    started: true,
    cause: null,
  });
  await vi.waitFor(() => expect(e.pendingOriginalContinuation).toBeNull());
  await e.handContinuation.join();
  expect(restored.getRemainingDeck()).toEqual(deck);
  expect(emitted.some((x) => x.type === 'HAND_START')).toBe(false);
  expect(emitted.some((x) => x.type === 'TURN_CHANGE')).toBe(true);
  complete(restored);
  await resumed;
  await e.handContinuation.join();
  expect(restored.getState().players.map((p) => p.stack)).toEqual(expected);
  expect(expected.reduce((n, v) => n + v, 0)).toBe(2000);
  expect(writes[0].sequence).toBe(8);
  expect(e.handCount).toBe(42);
  expect(emitted.filter((x) => x.type === 'HAND_COMPLETE')).toHaveLength(1);
});

it('holds an unknown retained write without publishing the controller batch', async () => {
  const { e, emitted, roster } = fixture();
  e.retainOriginalBatch = async (_o: unknown, _s: unknown, b: any) => {
    if (b.sequence > 0) throw Error('Lost Acknowledgement');
  };
  const waiting = e.runOriginalController(roster, e.handController, 42, Date.now(), {
    started: false,
    cause: null,
  });
  await vi.waitFor(() =>
    expect(e.killForRestart).toHaveBeenCalledWith('hand_continuation_unproven')
  );
  await expect(e.handContinuation.join()).rejects.toThrow('Lost Acknowledgement');
  expect(emitted).toEqual([]);
  expect(e.getActionContext()).toBeNull();
  e.activeHandWaitRelease.release('test_held_owner');
  await waiting;
});

it('preserves cash completion release after its existing event consumer rejects', async () => {
  const { e, roster } = fixture();
  e.f06CurrentPermit = null;
  e.currentHandSeatGenerations.clear();
  e.currentHandDealtStacks.clear();
  const controller = e.handController;
  e.handleHandEvent = async (event: HandEvent) => {
    if (event.type === 'HAND_COMPLETE') throw Error('Existing Consumer Failed');
  };
  const run = e.runOriginalController(roster, controller, 42, Date.now(), {
    started: false,
    cause: null,
  });
  await vi.waitFor(() => expect(e.activeHandWaitRelease).toBeTruthy());
  expect(controller.performAction(controller.getState().currentPlayerSeat, 'fold')).toBe(true);
  await run;
  expect(e.handController).toBeNull();
  expect(e.handSafetyTimer).toBeNull();
  expect(e.handContinuation).toBeNull();
});
