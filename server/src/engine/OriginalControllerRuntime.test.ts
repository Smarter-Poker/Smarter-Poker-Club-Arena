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
import { F06HandPermit } from '../services/F06HandPermit.js';
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
    recoveryState: () => 'attempted',
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
  const roster = players.map((p) => ({
    user_id: p.user_id,
    seat_number: p.seat,
    stack: p.stack,
    seat_id: '00000000-0000-4000-8000-00000000000' + p.seat,
    seat_joined_at: '2026-10-28T00:00:00Z',
    is_horse: false,
  }));
  e.seatedPlayers = roster;
  e.fetchTimeBankExtras = async () => new Map();
  for (const p of players) {
    e.timeBankEngine.initializePlayer(config.tableId, p.user_id);
    e.timeBankEngine.setAutoActivate(config.tableId, p.user_id, false);
  }
  return { e, emitted, roster };
}
async function originalPermit(e: any): Promise<F06HandPermit> {
  const permit = new F06HandPermit(
    binding,
    async () => ({
      data: {
        ok: true,
        tournament_id: binding.tournament_id,
        generation: binding.lease_generation,
        custody_id: binding.custody_id,
        permit_id: binding.permit_id,
        table_id: binding.table_id,
        lifecycle: binding.lifecycle,
        hand_number: binding.hand_number,
        state: 'reserved',
      },
      error: null,
    }),
    () => true,
    () => !e.isNextHandPaused()
  );
  await permit.reserve();
  e.f06CurrentPermit = permit;
  e.engineLeaseAuthorityIsCurrent = () => true;
  return permit;
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
  let restored = HandController.fromRecoveryState(saved, config.tableId, 42);
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
      seat_id: p.seat_id,
      seat_joined_at: '2026-10-28T00:00:00Z',
      stack_before: 1000,
    })),
    batch: { version: 1, sequence: 7, controller: saved, events: [], engine: { fields: {} } },
  };
  const writes: any[] = [];
  e.retainOriginalBatch = async (_o: unknown, _s: unknown, b: any) => {
    writes.push(structuredClone(b));
  };
  const resumed = e.resumeOriginalController();
  await vi.waitFor(() => expect(e.pendingOriginalContinuation).toBeNull());
  await e.handContinuation.join();
  restored = e.handController;
  expect(e.lastButtonSeat).toBe(1);
  expect(e.lastBigBlindSeat).toBe(2);
  expect(e.predictButtonSeat(roster)).toBe(2);
  expect(e.dealtInUserIds).toEqual(new Set(['u1', 'u2']));
  expect(e.atomicStackService.getStackWithVersion(config.tableId, 'u1').stack).toBe(1000);
  expect(restored.getRemainingDeck()).toEqual(deck);
  expect(emitted.some((x) => x.type === 'HAND_START')).toBe(false);
  expect(emitted.some((x) => x.type === 'TURN_CHANGE')).toBe(true);
  // A reconstructed controller remains the original weekly pause's physical
  // owner. The money phase must not mistake its started hand for preparation.
  expect(e.weeklyPayoutStartedController).toBe(restored);
  e.engineLeaseAuthorityIsCurrent = () => true;
  e.f06CurrentPermit.recoveryState = () => 'attempted';
  e.broadcastCurrentState = async () => {};
  const owner = 'weekly-original-recovery';
  e.pauseForWeeklyPayout(owner);
  e.engageWeeklyPayoutHandPause(owner);
  await vi.waitFor(() => expect(e.isParkedForWeeklyPayout(owner)).toBe(true));
  const paused = restored.serializeRecoveryState();
  const actor = restored.getState().currentPlayerSeat;
  expect(restored.performAction(actor, 'call')).toBe(false);
  expect(restored.serializeRecoveryState()).toBe(paused);
  expect(restored.getRemainingDeck()).toEqual(deck);
  e.resumeFromWeeklyPayout(owner);
  expect(e.isParkedForWeeklyPayout(owner)).toBe(false);
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

it.each([false, true])(
  'keeps a retained prepared original through weekly release (outer checkpoint race: %s)',
  async (outerCheckpointRace) => {
    const { e, emitted, roster } = fixture();
    const controller: HandController = e.handController;
    const permit = await originalPermit(e);
    let anchor: any;
    let acknowledge!: () => void;
    e.retainOriginalBatch = async (_original: unknown, _seats: unknown, batch: any) => {
      if (batch.sequence === 0) {
        anchor = structuredClone(batch);
        await new Promise<void>((resolve) => {
          acknowledge = resolve;
        });
      }
    };
    const attempt = { started: false, cause: null };
    const run = e.runOriginalController(roster, controller, 42, Date.now(), attempt);
    await vi.waitFor(() => expect(anchor?.sequence).toBe(0));
    const originalDeck = controller.getRemainingDeck();
    const owner = 'weekly-prepared-original';
    const secondOwner = 'weekly-handoff-microtask';
    let crossedFinalCheckpoint = false;
    if (outerCheckpointRace) {
      const checkpoint = e.weeklyHandPause.checkpoint.bind(e.weeklyHandPause);
      let completedCheckpoints = 0;
      vi.spyOn(e.weeklyHandPause, 'checkpoint').mockImplementation(() =>
        checkpoint().then((current: boolean) => {
          if (current && ++completedCheckpoints === 2) {
            queueMicrotask(() => {
              e.pauseForWeeklyPayout(secondOwner);
              e.engageWeeklyPayoutHandPause(secondOwner);
              crossedFinalCheckpoint = true;
            });
          }
          return current;
        })
      );
    }
    let physicalReadyObserved = false;
    const stopReady = e.onWeeklyPayoutBoundary(() => {
      if (e.isParkedForWeeklyPayout(owner)) physicalReadyObserved = true;
    });
    e.pauseForWeeklyPayout(owner);
    e.engageWeeklyPayoutHandPause(owner);
    expect(permit.recoveryState()).toBe('attempted');
    expect(JSON.parse(anchor.controller).handStarted).toBe(false);
    expect(emitted).toEqual([]);
    acknowledge();
    for (let turn = 0; turn < 8; turn++) await Promise.resolve();
    expect(e.handController).toBe(controller);
    expect(attempt.cause).toBeNull();
    expect(attempt.started).toBe(false);
    expect(emitted).toEqual([]);
    expect(controller.getRemainingDeck()).toEqual(originalDeck);
    await vi.waitFor(() => expect(e.isParkedForWeeklyPayout(owner)).toBe(true));
    expect(physicalReadyObserved).toBe(true);
    stopReady();
    e.broadcastCurrentState = async () => {};
    e.resumeFromWeeklyPayout(owner);
    if (outerCheckpointRace) {
      await vi.waitFor(() => expect(crossedFinalCheckpoint).toBe(true));
      expect(e.handController).toBe(controller);
      expect(attempt.cause).toBeNull();
      expect(attempt.started).toBe(false);
      expect(emitted).toEqual([]);
      expect(e.isParkedForWeeklyPayout(secondOwner)).toBe(true);
      e.resumeFromWeeklyPayout(secondOwner);
    }
    await vi.waitFor(() =>
      expect(emitted.some((event) => event.type === 'CARDS_DEALT')).toBe(true)
    );
    expect(e.handCount).toBe(42);
    expect(permit.binding).toEqual(binding);
    expect(attempt.started).toBe(true);
    const state = controller.getState();
    expect(controller.performAction(state.currentPlayerSeat, 'fold')).toBe(true);
    await run;
    await e.handContinuation.join();
    expect(emitted.filter((event) => event.type === 'HAND_START')).toHaveLength(1);
    expect(emitted.filter((event) => event.type === 'HAND_COMPLETE')).toHaveLength(1);
  }
);

it('keeps the retained prepared original when maintenance arrives during its first private save', async () => {
  const { e, emitted, roster } = fixture();
  const controller: HandController = e.handController;
  const permit = await originalPermit(e);
  let anchor: any;
  let acknowledge!: () => void;
  e.retainOriginalBatch = async (_original: unknown, _seats: unknown, batch: any) => {
    if (batch.sequence === 0) {
      anchor = structuredClone(batch);
      await new Promise<void>((resolve) => {
        acknowledge = resolve;
      });
    }
  };
  const attempt = { started: false, cause: null };
  const run = e.runOriginalController(roster, controller, 42, Date.now(), attempt);
  await vi.waitFor(() => expect(anchor?.sequence).toBe(0));
  const deck = controller.getRemainingDeck();
  e.pauseForMaintenance(420_000);
  acknowledge();
  await vi.waitFor(() => expect(e.handForHandResolve).not.toBeNull());
  expect(e.handController).toBe(controller);
  expect(e.isMaintenancePaused()).toBe(true);
  expect(e.isBetweenHands()).toBe(false);
  expect(permit.recoveryState()).toBe('attempted');
  expect(attempt.cause).toBeNull();
  expect(attempt.started).toBe(false);
  expect(emitted).toEqual([]);
  expect(controller.getRemainingDeck()).toEqual(deck);
  e.resumeFromMaintenance();
  await vi.waitFor(() => expect(emitted.some((event) => event.type === 'CARDS_DEALT')).toBe(true));
  expect(e.handCount).toBe(42);
  expect(permit.binding).toEqual(binding);
  const state = controller.getState();
  expect(controller.performAction(state.currentPlayerSeat, 'fold')).toBe(true);
  await run;
  await e.handContinuation.join();
  expect(emitted.filter((event) => event.type === 'HAND_START')).toHaveLength(1);
  expect(emitted.filter((event) => event.type === 'HAND_COMPLETE')).toHaveLength(1);
});

it.each([false, true])(
  'fences a prepared original refused by a polled owner (claimed: %s)',
  async (claimed) => {
    const { e, emitted, roster } = fixture();
    const controller: HandController = e.handController;
    if (claimed) {
      e.f06CurrentPermit = new F06HandPermit(
        binding,
        async () => {
          throw Error('Unexpected Recovered RPC');
        },
        () => true,
        () => !e.isNextHandPaused(),
        binding.lease_generation
      );
      e.pendingOriginalContinuation = {
        version: 1,
        original: binding,
        seats: roster.map((player) => ({
          user_id: player.user_id,
          seat_id: player.seat_id,
          seat_joined_at: player.seat_joined_at,
          stack_before: player.stack,
        })),
        batch: {
          version: 1,
          sequence: 0,
          controller: controller.serializeRecoveryState(),
          events: [],
          engine: { fields: {} },
        },
      };
      e.adminPauseLock = true;
      e.retainOriginalBatch = async () => {
        throw Error('Unexpected Second Retention');
      };
    } else {
      await originalPermit(e);
      e.retainOriginalBatch = async (_original: unknown, _seats: unknown, batch: any) => {
        expect(batch.sequence).toBe(0);
        // The polled owner arrives after exact private retention, before start.
        e.adminPauseLock = true;
      };
    }
    await e.runOriginalController(roster, controller, 42, Date.now(), {
      started: false,
      cause: null,
    });
    expect(e.killForRestart).toHaveBeenCalledWith('retained_original_start_unproven');
    expect(emitted).toEqual([]);
    expect(e.handController).toBe(controller);
    expect(JSON.parse(controller.serializeRecoveryState()).handStarted).toBe(false);
    expect(e.f06CurrentPermit.recoveryState()).toBe('attempted');
  }
);
