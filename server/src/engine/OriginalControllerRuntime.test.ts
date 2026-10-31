import { afterEach, expect, it, vi } from 'vitest';
const { timeBankRpc } = vi.hoisted(() => ({
  timeBankRpc: vi.fn((..._args: unknown[]): any => {
    throw Error('Unexpected RPC');
  }),
}));
vi.mock('../services/supabase/client.js', () => ({
  supabase: {
    from: () => {
      throw Error('Unexpected SQL');
    },
    rpc: (...args: unknown[]) => timeBankRpc(...args),
  },
  maintenanceSupabase: {},
}));
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn(), reportWarning: vi.fn() }));
const { originalAuth } = vi.hoisted(() => ({ originalAuth: { userId: 'u1' } }));
vi.mock('../http/auth.js', () => ({
  authenticateRequest: vi.fn(async () => ({ userId: originalAuth.userId })),
}));
vi.mock('../http/body.js', () => ({
  readBody: vi.fn(async (req: { __body?: string }) => req.__body ?? '{}'),
}));
import { DeadlineScheduler } from './DeadlineScheduler.js';
import { PreciseActionTimer } from './PreciseActionTimer.js';
import { ServerTableEngine } from './ServerTableEngine.js';
import { HandController } from './HandController.js';
import { F06HandPermit } from '../services/F06HandPermit.js';
import { TournamentManagerBase } from '../tournament/TournamentManagerBase.js';
import type { GameServer } from '../GameServer.js';
import { handleAction } from '../handlers/action.js';
import { __resetRateLimiterForTests } from '../http/rateLimit.js';
import { playerActionContext } from './PlayerActionContext.js';
import { encodePrivateHandContinuation } from './PrivateHandContinuation.js';
import { claimHandContinuation } from '../services/supabase/handContinuation.js';
import * as freezeState from '../maintenance/freezeState.js';
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
  originalAuth.userId = 'u1';
  timeBankRpc.mockReset().mockImplementation(() => {
    throw Error('Unexpected RPC');
  });
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
function fixture(tableId = config.tableId) {
  const e: any = new ServerTableEngine(tableId);
  engines.push(e);
  expect(e.claimProcessOwnership()).toBe(true);
  e.running = true;
  e.handCount = 42;
  e.lifecycleCanMutate = () => true;
  e.handController = new HandController({ ...config, tableId }, players, 1);
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
    binding: { ...binding, table_id: tableId },
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
    e.timeBankEngine.initializePlayer(tableId, p.user_id);
    e.timeBankEngine.setAutoActivate(tableId, p.user_id, false);
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

class OriginalBarrierHarness extends TournamentManagerBase {
  constructor(held: boolean) {
    super(binding.tournament_id, {} as GameServer);
    (this as any).lifecycleEpoch.begin();
    this.running = true;
    this.handForHandActive = held;
    this.gameServer.getTournamentHandForHand = () => this.getHandForHandPresentation();
  }
  protected override startEliminationChecker(): void {}
  protected override async recalculateEliminatedPrizes(): Promise<boolean> {
    return true;
  }
  add(tableId: string, engine: ServerTableEngine): void {
    this.tableEngines.set(tableId, engine);
    engine.onPauseReady(() => (this as any).advanceHandForHandBarrier());
  }
  arm(): void {
    this.startHandForHandSync();
  }
  edge(): void {
    (this as any).advanceHandForHandBarrier();
  }
}

it.each([
  { held: false, maintenance: false },
  { held: true, maintenance: false },
  { held: true, maintenance: true },
])(
  'finishes two started originals before admitting the third prepared original ($held/$maintenance)',
  async ({ held, maintenance }) => {
    const manager = new OriginalBarrierHarness(held);
    const entries = [
      fixture(),
      fixture('cccccccc-0000-4000-8000-0000000000a2'),
      fixture('cccccccc-0000-4000-8000-0000000000a3'),
    ];
    const runs: Array<Promise<void> | undefined> = [];
    const expected: number[][] = [];
    const decks: ReturnType<HandController['getRemainingDeck']>[] = [];
    const parked: Promise<void>[] = [];
    const restored: HandController[] = [];
    try {
      for (const [i, { e, roster }] of entries.entries()) {
        const controller: HandController = e.handController;
        if (i < 2) controller.start();
        const saved = controller.serializeRecoveryState();
        const check = HandController.fromRecoveryState(saved, e.tableId, 42);
        if (i === 2) check.resumeRecoveredHand();
        decks.push(check.getRemainingDeck());
        expect(check.performAction(check.getState().currentPlayerSeat, 'fold')).toBe(true);
        expected.push(check.getState().players.map((p) => p.stack));
        e.pendingOriginalContinuation = {
          version: 1,
          original: e.f06CurrentPermit.binding,
          seats: roster.map((p) => ({
            user_id: p.user_id,
            seat_id: p.seat_id,
            seat_joined_at: p.seat_joined_at,
            stack_before: 1000,
          })),
          batch: {
            version: 1,
            sequence: i === 2 ? 0 : 3,
            controller: saved,
            events: [],
            engine: { fields: {} },
          },
        };
        e.retainOriginalBatch = async () => {};
        manager.add(e.tableId, e);
        if (maintenance) {
          e.persistPresenceForRestart = async () => {};
          e.pauseForMaintenance(420000);
        }
        if (held) e.pauseAfterHand(420000, { beforeNextHand: true });
      }
      if (held) manager.arm();
      for (const [i, { e }] of entries.entries())
        if (!held || i < 2) runs[i] = e.resumeOriginalController();
      await vi.waitFor(() => {
        for (const { e } of entries.slice(0, 2)) expect(e.pendingOriginalContinuation).toBeNull();
      });
      for (const [i, { e, emitted }] of entries.slice(0, 2).entries()) {
        restored[i] = e.handController;
        expect(restored[i].getRemainingDeck()).toEqual(decks[i]);
        expect(emitted.some((x) => x.type === 'HAND_START')).toBe(false);
        expect(e.handCount).toBe(42);
        expect(e.isBetweenHands()).toBe(false);
        expect(e.isParkedBetweenHands()).toBe(false);
        if (held) expect(e.handForHandPaused).toBe(true);
        if (maintenance) expect(e.isMaintenancePaused()).toBe(true);
      }
      for (const [i, { e, emitted }] of entries.slice(0, 2).entries()) {
        expect(restored[i].performAction(restored[i].getState().currentPlayerSeat, 'fold')).toBe(
          true
        );
        await runs[i];
        await e.handContinuation.join();
        expect(e.handController).toBeNull();
        expect(restored[i].getState().players.map((p) => p.stack)).toEqual(expected[i]);
        expect(emitted.filter((x) => x.type === 'HAND_COMPLETE')).toHaveLength(1);
        if (held) {
          parked.push(e.awaitPauseGate());
          expect(e.isWaitingForHandForHand()).toBe(true);
        }
      }
      const third = entries[2];
      if (held) {
        expect(third.e.pendingOriginalContinuation.batch.sequence).toBe(0);
        expect(third.emitted).toEqual([]);
        expect(entries[0].e.isWaitingForHandForHand()).toBe(true);
        expect(entries[1].e.isWaitingForHandForHand()).toBe(true);
        if (maintenance) for (const { e } of entries) e.resumeFromMaintenance();
        runs[2] = third.e.resumeOriginalController();
      }
      await vi.waitFor(() => expect(third.e.pendingOriginalContinuation).toBeNull());
      await third.e.handContinuation.join();
      restored[2] = third.e.handController;
      expect(restored[2].getRemainingDeck()).toEqual(decks[2]);
      expect(third.emitted.filter((x) => x.type === 'HAND_START')).toHaveLength(1);
      expect(third.e.handCount).toBe(42);
      if (held) {
        await Promise.all(parked);
        for (const { e } of entries) expect(e.isWaitingForHandForHand()).toBe(false);
      }
      expect(restored[2].performAction(restored[2].getState().currentPlayerSeat, 'fold')).toBe(
        true
      );
      await runs[2];
      await third.e.handContinuation.join();
      expect(restored[2].getState().players.map((p) => p.stack)).toEqual(expected[2]);
      expect(third.emitted.filter((x) => x.type === 'HAND_COMPLETE')).toHaveLength(1);
      expect(expected.flat().reduce((a, b) => a + b, 0)).toBe(6000);
    } finally {
      for (const { e } of entries) {
        e.running = false;
        e.activeHandWaitRelease?.release('test_cleanup');
        e.releasePendingPauseWait();
      }
      await Promise.allSettled(runs.filter((r): r is Promise<void> => !!r));
      (manager as any).running = false;
      (manager as any).stopHandForHandSync();
    }
  }
);

it('does not resume retained live cards during the actual global freeze', async () => {
  const { e, emitted, roster } = fixture();
  const original: HandController = e.handController;
  original.start();
  const saved = original.serializeRecoveryState();
  e.pendingOriginalContinuation = {
    version: 1,
    original: binding,
    seats: roster.map((p) => ({
      user_id: p.user_id,
      seat_id: p.seat_id,
      seat_joined_at: p.seat_joined_at,
      stack_before: 1000,
    })),
    batch: { version: 1, sequence: 3, controller: saved, events: [], engine: { fields: {} } },
  };
  e.retainOriginalBatch = async () => {};
  vi.spyOn(freezeState, 'isMaintenanceFrozen').mockReturnValue(true);
  await e.resumeOriginalController();
  expect(e.killForRestart).toHaveBeenCalledWith('retained_original_start_unproven');
  expect(emitted).toEqual([]);
  expect(e.pendingOriginalContinuation.batch.controller).toBe(saved);
  expect(e.handController.serializeRecoveryState()).toBe(saved);
});

it('refuses HTTP, trusted actions, bank use and controller mutation until the restored original actuates', async () => {
  const { e, roster, emitted } = fixture();
  const initial: HandController = e.handController;
  initial.start();
  const saved = initial.serializeRecoveryState();
  e.pendingOriginalContinuation = {
    version: 1,
    original: binding,
    seats: roster.map((p) => ({
      user_id: p.user_id,
      seat_id: p.seat_id,
      seat_joined_at: p.seat_joined_at,
      stack_before: 1000,
    })),
    batch: { version: 1, sequence: 3, controller: saved, events: [], engine: { fields: {} } },
  };
  e.retainOriginalBatch = async () => {};
  let release!: () => void;
  e.fetchTimeBankExtras = () =>
    new Promise<Map<string, never>>((r) => {
      release = () => r(new Map<string, never>());
    });
  const resumed = e.resumeOriginalController();
  const request = async (key: string, context: string) => {
    let status = 0;
    let body = '';
    const res = {
      writeHead: (n: number) => {
        status = n;
        return res;
      },
      end: (b?: string) => {
        body = b ?? '';
      },
    };
    __resetRateLimiterForTests();
    await handleAction(
      {
        __body: JSON.stringify({
          tableId: config.tableId,
          action: 'fold',
          actionContext: context,
          idempotencyKey: key,
        }),
      } as never,
      res as never,
      { gameServer: { getTableEngine: () => e } }
    );
    return { status, body: JSON.parse(body) };
  };
  try {
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const restored: HandController = e.handController;
    const context = playerActionContext(restored);
    if (!context) throw new Error('Expected The Retained Original Decision');
    const result = await request('original-unactuated-1', context);
    expect(result.body.success).toBe(false);
    expect(e.getActionContext()).toBeNull();
    expect(e.getPlayerActions('u1').actions).toEqual([]);
    expect(e.handlePlayerAction('u1', 'fold').success).toBe(false);
    expect((await e.activateTimeBank('u1')).success).toBe(false);
    expect(restored.performAction(restored.getState().currentPlayerSeat, 'fold')).toBe(false);
    expect(restored.serializeRecoveryState()).toBe(saved);
    expect(emitted).toEqual([]);
    await expect(e.awaitActionPersistence()).rejects.toThrow('Not Actuated');
    release();
    await vi.waitFor(() => expect(e.pendingOriginalContinuation).toBeNull());
    await e.handContinuation.join();
    expect(e.handController).toBe(restored);
    expect(e.getActionContext()).toBe(context);
    const accepted = await request('original-unactuated-2', context);
    expect(accepted.body.success).toBe(true);
    await resumed;
    await e.handContinuation.join();
    expect(emitted.filter((x) => x.type === 'HAND_COMPLETE')).toHaveLength(1);
  } finally {
    e.running = false;
    release?.();
    e.activeHandWaitRelease?.release('test_cleanup');
    e.releasePendingPauseWait();
    await resumed;
  }
});

it('serializes the retained old consumer before a new capsule and publishes original readiness once', async () => {
  const { e, roster, emitted } = fixture();
  const c: HandController = e.handController;
  const events: HandEvent[] = [];
  c.onEvent((x) => events.push(structuredClone(x)));
  c.start();
  const saved = c.serializeRecoveryState();
  const turn = events.find((x) => x.type === 'TURN_CHANGE')!;
  expect(turn).toBeTruthy();
  const expected = HandController.fromRecoveryState(saved, config.tableId, 42);
  expect(expected.performAction(expected.getState().currentPlayerSeat, 'call')).toBe(true);
  expect(expected.performAction(expected.getState().currentPlayerSeat, 'fold')).toBe(true);
  e.pendingOriginalContinuation = {
    version: 1,
    original: binding,
    seats: roster.map((p) => ({
      user_id: p.user_id,
      seat_id: p.seat_id,
      seat_joined_at: p.seat_joined_at,
      stack_before: 1000,
    })),
    batch: {
      version: 1,
      sequence: 3,
      controller: saved,
      events: [turn],
      engine: { fields: { currentHandStartedAt: 111 } },
    },
  };
  e.tableInfo = {
    id: config.tableId,
    variant: 'nlh',
    game_variant: 'nlh',
    game_type: 'tournament',
    table_type: 'tournament',
    big_blind: 20,
    small_blind: 10,
    max_players: 2,
    ante: 0,
  };
  const published: any[] = [];
  e.hub = {
    publish: (_table: string, payload: any) => published.push(structuredClone(payload)),
    emitEvent: vi.fn(),
  };
  let release!: () => void;
  let entered = false;
  let oldConsumers = 0;
  const writes: any[] = [];
  e.handleHandEvent = async (x: HandEvent) => {
    if (x.type === 'TURN_CHANGE' && !entered) {
      entered = true;
      oldConsumers++;
      await e.broadcastCurrentState();
      await new Promise<void>((r) => (release = r));
      e.currentHandStartedAt = 222;
    } else emitted.push(x);
  };
  e.retainOriginalBatch = async (_o: unknown, _s: unknown, b: any) => {
    writes.push(structuredClone(b));
  };
  const resumed = e.resumeOriginalController();
  const request = async (key: string, ctx: string | null) => {
    let status = 0;
    let body = '';
    const res = {
      writeHead: (x: number) => {
        status = x;
        return res;
      },
      end: (x?: string) => {
        body = x ?? '';
      },
    };
    __resetRateLimiterForTests();
    await handleAction(
      {
        __body: JSON.stringify({
          tableId: config.tableId,
          action: 'fold',
          actionContext: ctx,
          idempotencyKey: key,
        }),
      } as never,
      res as never,
      { gameServer: { getTableEngine: () => e } }
    );
    return { status, body: JSON.parse(body) };
  };
  try {
    await vi.waitFor(() => expect(entered).toBe(true));
    const restored: HandController = e.handController;
    const ctx = playerActionContext(restored);
    const refused = await request('replay-overlap-1', ctx);
    expect({
      success: refused.body.success,
      retainedStartFields: writes.map((b) => b.engine.fields.currentHandStartedAt),
    }).toEqual({ success: false, retainedStartFields: [] });
    expect(e.getActionContext()).toBeNull();
    expect(published).toEqual([]);
    expect((await e.activateTimeBank('u1')).success).toBe(false);
    expect(
      restored.performAction(restored.getState().currentPlayerSeat, 'call', undefined, 'forced')
    ).toBe(true);
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(writes).toEqual([]);
    release();
    await e.handContinuation.join();
    await vi.waitFor(() => expect(published).toHaveLength(1));
    expect(writes.map((b) => b.sequence)).toEqual([4]);
    expect(writes[0].engine.fields.currentHandStartedAt).toBe(222);
    expect(oldConsumers).toBe(1);
    expect(published[0].action_context).toBe(playerActionContext(restored));
    expect(published[0].action_context).toBeTruthy();
    expect(e.handController).toBe(restored);
    originalAuth.userId = 'u2';
    const accepted = await request('replay-ready-2', published[0].action_context);
    expect(accepted.body.success).toBe(true);
    await resumed;
    await e.handContinuation.join();
    expect(writes.map((b) => b.sequence)).toEqual([4, 5]);
    expect(emitted.filter((x) => x.type === 'HAND_START')).toHaveLength(0);
    expect(emitted.filter((x) => x.type === 'HAND_COMPLETE')).toHaveLength(1);
    expect(restored.getState().players.map((p) => p.stack)).toEqual(
      expected.getState().players.map((p) => p.stack)
    );
  } finally {
    e.running = false;
    release?.();
    e.activeHandWaitRelease?.release('test_cleanup');
    e.releasePendingPauseWait();
    await resumed;
  }
});

// A bank stop belongs to the retained terminal event. Re-enqueueing it after
// that event's atomic acceptance attempts to reopen an accepted original.
it.each([false, true])(
  'consumes terminal time-bank stops before accepting an original (recovered=%s)',
  async (recovered) => {
    const { e, roster } = fixture();
    const writes: any[] = [];
    const debits: Array<{ user: string; seconds: number; id: string }> = [];
    const publicStops: unknown[] = [];
    let accepted = false;
    let lateWrites = 0;
    e.hub = {
      emitEvent: (_table: string, event: any) => {
        if (event.type === 'time_bank_stopped') publicStops.push(event);
      },
    };
    e.submitTimeBankDebit = (user: string, seconds: number, id: string) => {
      expect(accepted).toBe(false);
      debits.push({ user, seconds, id });
    };
    e.timeBankMeta.set('u1', { initialSeconds: 40, baseSeconds: 0, dbConsumedSeconds: 0 });
    e.timeBankEngine.initializePlayer(config.tableId, 'u1', {
      remainingSeconds: 40,
      usesRemaining: 2,
    });
    e.retainOriginalBatch = async (_o: unknown, _s: unknown, batch: any) => {
      if (accepted) {
        lateWrites++;
        throw new Error('HAND_CONTINUATION_ORIGINAL_UNPROVEN');
      }
      writes.push(structuredClone(batch));
    };
    e.handleHandEvent = async (event: HandEvent) => {
      if (event.type === 'HAND_COMPLETE') {
        // The production settlement's existing hand-boundary bank cleanup,
        // followed by its accepted original transaction.
        e.timeBankEngine.cancelActiveForTable(config.tableId);
        accepted = true;
      }
    };
    let controller: HandController = e.handController;
    if (recovered) {
      const terminal: HandEvent[] = [];
      controller.onEvent((event) => terminal.push(event));
      controller.start();
      controller.performAction(controller.getState().currentPlayerSeat, 'fold');
      const encoded = controller.serializeRecoveryState();
      controller = HandController.fromRecoveryState(encoded, config.tableId, 42);
      e.handController = controller;
      e.pendingOriginalContinuation = {
        version: 1,
        original: binding,
        seats: roster.map((p) => ({
          user_id: p.user_id,
          seat_id: p.seat_id,
          seat_joined_at: p.seat_joined_at,
          stack_before: 1000,
        })),
        batch: {
          version: 1,
          sequence: 3,
          controller: encoded,
          events: terminal.filter((event) => ['WINNERS', 'HAND_COMPLETE'].includes(event.type)),
          engine: { fields: {} },
        },
      };
      expect(e.timeBankEngine.tryActivate(config.tableId, 'u1', () => {})).toBe('activated');
    }
    const started = e.runOriginalController(roster, controller, 42, Date.now(), {
      started: recovered,
      cause: null,
    });
    if (!recovered) {
      await vi.waitFor(() => expect(e.handContinuation).toBeTruthy());
      await e.handContinuation.join();
      expect(e.timeBankEngine.tryActivate(config.tableId, 'u1', () => {})).toBe('activated');
      await e.handContinuation.join();
      controller.performAction(controller.getState().currentPlayerSeat, 'fold');
    }
    await started;
    await expect(e.handContinuation.join()).resolves.toBeUndefined();
    expect(accepted).toBe(true);
    expect(lateWrites).toBe(0);
    expect(debits).toHaveLength(1);
    expect(debits[0]).toMatchObject({ user: 'u1', seconds: 20 });
    expect(debits[0].id).toMatch(/^[0-9a-f-]{36}$/);
    expect(publicStops).toHaveLength(1);
    expect(e.timeBankEngine.getPlayerBank(config.tableId, 'u1')).toMatchObject({
      isActive: false,
      remainingSeconds: 20,
      usesRemaining: 1,
    });
    e.timeBankEngine.cancelActiveForTable(config.tableId);
    await e.handContinuation.join();
    expect(debits).toHaveLength(1);
    expect(e.killForRestart).not.toHaveBeenCalled();
  }
);

it.each(['answered', 'unknown', 'fenced'])(
  'proves the terminal bank debit before original acceptance (outcome=%s)',
  async (outcome) => {
    const answered = outcome !== 'unknown';
    const { e, roster } = fixture();
    let accepted = false;
    let reply!: (value: unknown) => void;
    let debitId: string | undefined;
    timeBankRpc.mockImplementation(((name: string, args: any) => {
      if (name !== 'fn_consume_time_bank') throw Error('Unexpected RPC');
      expect(args.p_user_id).toBe('u1');
      expect(args.p_seconds).toBe(20);
      debitId = args.p_request_id;
      return new Promise((resolve) => {
        reply = resolve;
      });
    }) as any);
    e.timeBankMeta.set('u1', { initialSeconds: 40, baseSeconds: 0, dbConsumedSeconds: 0 });
    e.timeBankEngine.initializePlayer(config.tableId, 'u1', {
      remainingSeconds: 40,
      usesRemaining: 2,
    });
    e.retainOriginalBatch = async () => {};
    e.handleHandEvent = async (event: HandEvent) => {
      if (event.type === 'HAND_COMPLETE') {
        e.timeBankEngine.cancelActiveForTable(config.tableId);
        accepted = true;
      }
    };
    const controller: HandController = e.handController;
    const started = e.runOriginalController(roster, controller, 42, Date.now(), {
      started: false,
      cause: null,
    });
    await vi.waitFor(() => expect(e.handContinuation).toBeTruthy());
    await e.handContinuation.join();
    e.timeBankEngine.tryActivate(config.tableId, 'u1', () => {});
    await e.handContinuation.join();
    controller.performAction(controller.getState().currentPlayerSeat, 'fold');
    await vi.waitFor(() => expect(debitId).toBeTruthy());
    const acceptedWhileDebitPending = accepted;
    if (outcome === 'fenced') e.lifecycleCanMutate = () => false;
    reply(
      answered
        ? { data: { success: true }, error: null }
        : { data: null, error: { message: 'reply lost' } }
    );
    if (outcome === 'fenced') {
      await expect(e.handContinuation.join()).rejects.toThrow('Fenced');
      expect(accepted).toBe(false);
    } else if (answered) {
      await started;
      await expect(e.handContinuation.join()).resolves.toBeUndefined();
      expect(accepted).toBe(true);
      expect(e.unresolvedTimeBankDebits.size).toBe(0);
    } else {
      await expect(e.handContinuation.join()).rejects.toThrow('Completion Bank Debit Is Unproven');
      expect(accepted).toBe(false);
      expect(e.unresolvedTimeBankDebits.has(debitId)).toBe(true);
    }
    expect(acceptedWhileDebitPending).toBe(false);
  }
);

it('replays the captured terminal bank after an applied debit loses its answer without another charge', async () => {
  const first = fixture();
  let saved: any;
  let accepted = 0;
  let chargedSeconds = 0;
  const receiptIds: string[] = [];
  const receipts = new Set<string>();
  timeBankRpc.mockImplementation(((name: string, args: any) => {
    if (name !== 'fn_consume_time_bank') throw Error('Unexpected RPC');
    receiptIds.push(args.p_request_id);
    if (!receipts.has(args.p_request_id)) {
      receipts.add(args.p_request_id);
      chargedSeconds += args.p_seconds;
      return Promise.resolve({ data: null, error: { message: 'committed answer lost' } });
    }
    return Promise.resolve({ data: { success: true, idempotent_replay: true }, error: null });
  }) as any);
  first.e.timeBankMeta.set('u1', { initialSeconds: 40, baseSeconds: 0, dbConsumedSeconds: 0 });
  first.e.timeBankEngine.initializePlayer(config.tableId, 'u1', {
    remainingSeconds: 40,
    usesRemaining: 2,
  });
  first.e.retainOriginalBatch = async (original: unknown, seats: unknown, batch: any) => {
    saved = structuredClone({ version: 1, original, seats, batch });
  };
  first.e.handleHandEvent = async (event: HandEvent) => {
    if (event.type === 'HAND_COMPLETE') accepted++;
  };
  const controller: HandController = first.e.handController;
  const started = first.e.runOriginalController(first.roster, controller, 42, Date.now(), {
    started: false,
    cause: null,
  });
  await vi.waitFor(() => expect(first.e.handContinuation).toBeTruthy());
  await first.e.handContinuation.join();
  first.e.timeBankEngine.tryActivate(config.tableId, 'u1', () => {});
  await first.e.handContinuation.join();
  controller.performAction(controller.getState().currentPlayerSeat, 'fold');
  await expect(first.e.handContinuation.join()).rejects.toThrow(
    'Completion Bank Debit Is Unproven'
  );
  expect(accepted).toBe(0);
  expect(chargedSeconds).toBe(20);
  expect(saved.batch.engine.timeBankMeta.get('u1').dbConsumedSeconds).toBe(0);
  expect(
    saved.batch.engine.timeBanks.find((entry: any) => entry.userId === 'u1').bank
  ).toMatchObject({ isActive: true, currentUseSeconds: 20 });
  first.e.running = false;
  first.e.activeHandWaitRelease.release('simulated_process_loss');
  await started;
  first.e.handContinuation.close();
  (ServerTableEngine as any).releaseCurrentEngine(config.tableId, first.e);

  const successor = fixture();
  successor.e.pendingOriginalContinuation = saved;
  successor.e.retainOriginalBatch = async () => {
    throw Error('Unexpected replacement continuation');
  };
  successor.e.handleHandEvent = async (event: HandEvent) => {
    if (event.type === 'HAND_COMPLETE') {
      successor.e.timeBankEngine.cancelActiveForTable(config.tableId);
      accepted++;
    }
  };
  await successor.e.resumeOriginalController();
  await successor.e.handContinuation.join();
  expect(receiptIds).toHaveLength(2);
  expect(receiptIds[1]).toBe(receiptIds[0]);
  expect(receipts.size).toBe(1);
  expect(chargedSeconds).toBe(20);
  expect(accepted).toBe(1);
  expect(successor.e.timeBankEngine.getPlayerBank(config.tableId, 'u1')).toMatchObject({
    isActive: false,
    remainingSeconds: 20,
    usesRemaining: 1,
  });
  expect(successor.e.unresolvedTimeBankDebits.size).toBe(0);
  expect(successor.e.killForRestart).not.toHaveBeenCalled();
});

it('resumes a receipt-admitted funded chair with the original deck and delta baseline', async () => {
  const { e, emitted, roster } = fixture();
  const saved = e.handController.serializeRecoveryState();
  const expected = HandController.fromRecoveryState(saved, config.tableId, 42);
  expected.start();
  const encoded = encodePrivateHandContinuation({
    version: 1,
    original: binding,
    seats: roster.map((p) => ({
      user_id: p.user_id,
      seat_id: p.seat_id,
      seat_joined_at: p.seat_joined_at,
      stack_before: p.stack,
    })),
    batch: { version: 1, sequence: 0, controller: saved, events: [], engine: { fields: {} } },
  });
  const writer = 'bbbbbbbb-0000-4000-8000-0000000000a2';
  roster[0].stack += 10_000;
  const claimed = await claimHandContinuation(
    binding.tournament_id,
    writer,
    config.tableId,
    () => true,
    async () => ({
      error: null,
      data: {
        ok: true,
        table_id: config.tableId,
        writer_generation: writer,
        continuation: {
          payload: encoded.payload,
          sha256: encoded.sha256,
          hand_number: binding.hand_number,
          sequence: '0',
        },
        chair_admission: {
          version: 1,
          tournament_id: binding.tournament_id,
          table_id: config.tableId,
          writer_generation: writer,
          original_generation: binding.lease_generation,
          hand_number: binding.hand_number,
          sequence: '0',
          payload_sha256: encoded.sha256,
          seats: roster.map((p) => ({
            user_id: p.user_id,
            seat_id: p.seat_id,
            seat_joined_at: p.seat_joined_at,
            stack_before: 1000,
            authorized_stack: p.stack,
          })),
        },
      },
    })
  );
  expect(encodePrivateHandContinuation(claimed!)).toEqual(encoded);
  e.pendingOriginalContinuation = claimed;
  const retained: any[] = [];
  e.retainOriginalBatch = async (_o: unknown, seats: unknown, batch: any) => {
    retained.push({ seats: structuredClone(seats), batch: structuredClone(batch) });
  };
  let recoveryFailure: unknown;
  const resumed = e.resumeOriginalController();
  void resumed.catch((error: unknown) => {
    recoveryFailure = error;
  });
  await vi.waitFor(() => {
    if (recoveryFailure) throw recoveryFailure;
    expect(e.pendingOriginalContinuation).toBeNull();
  });
  await e.handContinuation.join();
  expect(roster[0].stack).toBe(11_000);
  expect(e.handController.getRemainingDeck()).toEqual(expected.getRemainingDeck());
  expect(e.handController.getState().players.map((p: SeatPlayer) => p.cards)).toEqual(
    expected.getState().players.map((p: SeatPlayer) => p.cards)
  );
  expect(e.atomicStackService.getStackWithVersion(config.tableId, 'u1').stack).toBe(1000);
  expect(
    e.handController.getState().players.map((p: SeatPlayer) => p.stack + p.totalInvested)
  ).toEqual([1000, 1000]);
  expect(retained.every((x) => x.seats.every((seat: any) => seat.stack_before === 1000))).toBe(
    true
  );
  expect(
    e.handController.performAction(e.handController.getState().currentPlayerSeat, 'fold')
  ).toBe(true);
  await resumed;
  await e.handContinuation.join();
  expect(emitted.filter((x) => x.type === 'HAND_COMPLETE')).toHaveLength(1);
  expect(encodePrivateHandContinuation(claimed!)).toEqual(encoded);
  expect(e.killForRestart).not.toHaveBeenCalled();
});

it('does not authorize a larger chair from a copied or serialized admission', async () => {
  const { e, roster } = fixture();
  const original = {
    version: 1,
    original: binding,
    seats: roster.map((p) => ({
      user_id: p.user_id,
      seat_id: p.seat_id,
      seat_joined_at: p.seat_joined_at,
      stack_before: p.stack,
    })),
    batch: {
      version: 1,
      sequence: 0,
      controller: e.handController.serializeRecoveryState(),
      events: [],
      engine: { fields: {} },
    },
    chair_admission: { seats: [{ user_id: 'u1', authorized_stack: 11000 }] },
  };
  roster[0].stack += 10000;
  e.pendingOriginalContinuation = original;
  await expect(e.resumeOriginalController()).rejects.toThrow('Original Hand Chair Changed');
  expect(e.handContinuation).toBeNull();
  expect(roster[0].stack).toBe(11000);
});

async function delayedFundedChairFixture() {
  const state = fixture();
  const saved = state.e.handController.serializeRecoveryState();
  const encoded = encodePrivateHandContinuation({
    version: 1,
    original: binding,
    seats: state.roster.map((p) => ({
      user_id: p.user_id,
      seat_id: p.seat_id,
      seat_joined_at: p.seat_joined_at,
      stack_before: p.stack,
    })),
    batch: { version: 1, sequence: 0, controller: saved, events: [], engine: { fields: {} } },
  });
  const writer = 'bbbbbbbb-0000-4000-8000-0000000000a2';
  const response = () => ({
    ok: true,
    table_id: config.tableId,
    writer_generation: writer,
    continuation: {
      payload: encoded.payload,
      sha256: encoded.sha256,
      hand_number: binding.hand_number,
      sequence: '0',
    },
    chair_admission: {
      version: 1,
      tournament_id: binding.tournament_id,
      table_id: config.tableId,
      writer_generation: writer,
      original_generation: binding.lease_generation,
      hand_number: binding.hand_number,
      sequence: '0',
      payload_sha256: encoded.sha256,
      seats: state.roster.map((p) => ({
        user_id: p.user_id,
        seat_id: p.seat_id,
        seat_joined_at: p.seat_joined_at,
        stack_before: 1000,
        authorized_stack: p.stack,
      })),
    },
  });
  const claimed = (await claimHandContinuation(
    binding.tournament_id,
    writer,
    config.tableId,
    () => true,
    async () => ({ data: response(), error: null })
  ))!;
  state.e.pendingOriginalContinuation = claimed;
  return { ...state, saved, encoded, claimed, writer, response };
}

it('reclaims a funded add-on arriving after initial claim before actuating the exact original', async () => {
  const { e, roster, emitted, saved, encoded, claimed, writer, response } =
    await delayedFundedChairFixture();
  const before = e.handController;
  const expected = HandController.fromRecoveryState(saved, config.tableId, 42);
  expected.start();
  // Initial SQL claim authorized 1000; the separate later purchase credits the chair.
  roster[0].stack += 10_000;
  let acknowledge!: (value: unknown) => void;
  const answer = new Promise((resolve) => {
    acknowledge = resolve;
  });
  timeBankRpc.mockImplementation(((name: string, input: Record<string, unknown>) => {
    expect(name).toBe('fn_f06_claim_hand_continuation');
    expect(input).toEqual({
      p_tournament_id: binding.tournament_id,
      p_lease_generation: writer,
      p_table_id: config.tableId,
    });
    return { abortSignal: () => answer };
  }) as any);
  const retained: any[] = [];
  e.retainOriginalBatch = async (_identity: unknown, seats: unknown, batch: unknown) => {
    retained.push({ seats: structuredClone(seats), batch: structuredClone(batch) });
  };
  let failure: unknown;
  const resumed = e.resumeOriginalController();
  void resumed.catch((error: unknown) => {
    failure = error;
  });
  try {
    await vi.waitFor(() => expect(timeBankRpc).toHaveBeenCalledOnce());
    expect(e.handController).toBe(before);
    expect(before.serializeRecoveryState()).toBe(saved);
    expect(e.handContinuation).toBeNull();
    expect(emitted).toEqual([]);
    expect(retained).toEqual([]);
    expect(encodePrivateHandContinuation(claimed)).toEqual(encoded);
    acknowledge({ data: response(), error: null });
    await vi.waitFor(() => {
      if (failure) throw failure;
      expect(e.pendingOriginalContinuation).toBeNull();
    });
    await e.handContinuation.join();
    expect(timeBankRpc).toHaveBeenCalledOnce();
    expect(roster[0].stack).toBe(11000);
    expect(e.handController.getRemainingDeck()).toEqual(expected.getRemainingDeck());
    expect(e.handController.getState().players.map((p: SeatPlayer) => p.cards)).toEqual(
      expected.getState().players.map((p: SeatPlayer) => p.cards)
    );
    expect(e.atomicStackService.getStackWithVersion(config.tableId, 'u1').stack).toBe(1000);
    expect(
      e.handController.getState().players.map((p: SeatPlayer) => p.stack + p.totalInvested)
    ).toEqual([1000, 1000]);
    expect(retained.length).toBeGreaterThan(0);
    expect(retained.every((x) => x.seats.every((seat: any) => seat.stack_before === 1000))).toBe(
      true
    );
    expect(
      e.handController.performAction(e.handController.getState().currentPlayerSeat, 'fold')
    ).toBe(true);
    await resumed;
    await e.handContinuation.join();
    expect(emitted.filter((x) => x.type === 'HAND_COMPLETE')).toHaveLength(1);
    expect(encodePrivateHandContinuation(claimed)).toEqual(encoded);
    expect(e.killForRestart).not.toHaveBeenCalled();
  } finally {
    acknowledge?.({ data: null, error: { message: 'fixture cleanup' } });
    e.running = false;
    e.activeHandWaitRelease?.release('test_cleanup');
    e.releasePendingPauseWait();
    await resumed.catch(() => undefined);
  }
});

it('refuses an unfunded post-claim stack change before original controller mutation', async () => {
  const { e, roster, emitted, saved, encoded, claimed } = await delayedFundedChairFixture();
  const before = e.handController;
  roster[0].stack += 10_000;
  timeBankRpc.mockImplementation(((name: string) => {
    expect(name).toBe('fn_f06_claim_hand_continuation');
    return {
      abortSignal: async () => ({
        data: null,
        error: { message: 'HAND_CONTINUATION_ROSTER_CHANGED' },
      }),
    };
  }) as any);
  const capture = vi.spyOn(e, 'captureContinuationEngine');
  await expect(e.resumeOriginalController()).rejects.toThrow('Hand Continuation Claim Is Unproven');
  expect(timeBankRpc).toHaveBeenCalledOnce();
  expect(e.handController).toBe(before);
  expect(before.serializeRecoveryState()).toBe(saved);
  expect(e.pendingOriginalContinuation).toBe(claimed);
  expect(e.handContinuation).toBeNull();
  expect(capture).not.toHaveBeenCalled();
  expect(emitted).toEqual([]);
  expect(roster[0].stack).toBe(11000);
  expect(encodePrivateHandContinuation(claimed)).toEqual(encoded);
  expect(e.killForRestart).not.toHaveBeenCalled();
});

it.each([
  'ready',
  'action_fold',
  'action_call',
  'action_raise',
  'peer_resync',
  'publish_failed',
  'superseded',
  'hand_completed',
  'retention_failed',
] as const)('publishes only retained current input after a pending read: %s', async (mode) => {
  const { e, roster, emitted } = fixture();
  const published: any[] = [];
  e.tableInfo = { game_variant: 'nlh', big_blind: 20, small_blind: 10, max_players: 2 };
  e.hub = {
    publish: (_id: string, state: any) => {
      if (mode === 'publish_failed') throw Error('publication unavailable');
      published.push(structuredClone(state));
    },
    emitEvent: vi.fn(),
  };
  let blocked = false;
  let release: (() => void) | undefined;
  e.retainOriginalBatch = async (_o: unknown, _s: unknown, batch: any) => {
    if (blocked) {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      if (mode === 'retention_failed') throw Error('retention refused');
    }
    e.retainedPublicHandState = JSON.parse(batch.controller).state;
  };
  const controller = e.handController;
  const started = e.runOriginalController(roster, controller, 42, Date.now(), {
    started: false,
    cause: null,
  });
  try {
    await vi.waitFor(() => expect(e.handContinuation).toBeTruthy());
    await e.handContinuation.join();
    const decision = e.getActionContext();
    expect(decision).toBeTruthy();
    blocked = true;
    if (mode === 'peer_resync') {
      e.handleHandEvent = async () => {
        expect(e.getTableState('u2').action_context).toBe(decision);
      };
      e.handContinuation.enqueue({
        type: 'TURN_CHANGE',
        seat: controller.getState().currentPlayerSeat,
        availableActions: [],
      });
    } else e.handContinuation.checkpoint();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    expect(e.getTableState('u1').action_context).toBeNull();
    expect(e.getActionContext()).toBeNull();
    expect(published).toHaveLength(0);
    if (mode === 'superseded') e.isCurrentEngine = () => false;
    if (mode === 'hand_completed')
      expect(controller.performAction(controller.getState().currentPlayerSeat, 'fold')).toBe(true);
    blocked = false;
    release!();
    if (mode === 'retention_failed' || mode === 'superseded') {
      await expect(e.handContinuation.join()).rejects.toThrow();
      expect(published).toHaveLength(0);
      return;
    }
    await e.handContinuation.join();
    if (mode === 'hand_completed') {
      expect(published).toHaveLength(0);
      return;
    }
    expect(e.getActionContext()).toBe(decision);
    if (mode === 'publish_failed') {
      expect(published).toHaveLength(0);
      expect(e.handContinuation.isUnretained()).toBe(false);
      expect(e.killForRestart).not.toHaveBeenCalled();
      return;
    }
    expect(published).toHaveLength(1);
    expect(published[0].action_context).toBe(decision);
    e.handContinuation.checkpoint();
    await e.handContinuation.join();
    expect(published).toHaveLength(1);
    expect(
      controller
        .getState()
        .actionHistory.filter((a: any) => !['sb', 'bb', 'ante'].includes(a.action))
    ).toEqual([]);
    if (mode === 'action_fold' || mode === 'action_call' || mode === 'action_raise') {
      const action = mode.slice('action_'.length);
      originalAuth.userId = 'u' + controller.getState().currentPlayerSeat;
      const request = async () => {
        let status = 0;
        let body = '';
        const res = {
          writeHead: (code: number) => {
            status = code;
            return res;
          },
          end: (value?: string) => {
            body = value ?? '';
          },
        };
        __resetRateLimiterForTests();
        await handleAction(
          {
            __body: JSON.stringify({
              tableId: config.tableId,
              action,
              // Heads-up blinds 10/20: raising to 40 is a legal full raise.
              ...(action === 'raise' ? { amount: 40 } : {}),
              actionContext: published[0].action_context,
              idempotencyKey: `retained-ready-${action}`,
            }),
          } as never,
          res as never,
          { gameServer: { getTableEngine: () => e } }
        );
        return { status, body: JSON.parse(body) };
      };
      const accepted = await request();
      expect(accepted.status).toBe(200);
      expect(accepted.body.success).toBe(true);
      await e.handContinuation.join();
      const acceptedState = controller.serializeRecoveryState();
      const eventsBeforeReplay = emitted.length;
      const actions = controller
        .getState()
        .actionHistory.filter((entry: any) => !['sb', 'bb', 'ante'].includes(entry.action));
      expect(actions).toHaveLength(1);
      expect(actions[0].action).toBe(action);
      expect(emitted.filter((event: HandEvent) => event.type === 'PLAYER_ACTION')).toHaveLength(1);
      const replay = await request();
      expect(replay.status).toBe(200);
      expect(replay.body).toMatchObject({ success: true, replayed: true });
      await e.handContinuation.join();
      expect(controller.serializeRecoveryState()).toBe(acceptedState);
      expect(emitted).toHaveLength(eventsBeforeReplay);
    }
  } finally {
    blocked = false;
    release?.();
    e.running = false;
    e.activeHandWaitRelease?.release('test_cleanup');
    await started;
  }
});

it.each([
  'unchanged',
  'changed',
  'stopped',
  'delayed_fold',
  'delayed_call',
  'delayed_raise',
  'delayed_changed',
  'delayed_stopped',
] as const)('preserves turn ownership across a control checkpoint: %s', async (mode) => {
  const { e, roster } = fixture();
  e.tableInfo = { game_variant: 'nlh', big_blind: 20, small_blind: 10, max_players: 2 };
  e.hub = { publish: vi.fn(), emitEvent: vi.fn() };
  let now = Date.now();
  const scheduler = new DeadlineScheduler({ now: () => now });
  e.preciseTimer.dispose();
  e.preciseTimer = new PreciseActionTimer(undefined, scheduler, () => now);
  scheduler.stop();
  let delayRetention = false;
  let releaseRetention: (() => void) | undefined;
  e.retainOriginalBatch = async (_o: unknown, _s: unknown, batch: any) => {
    if (delayRetention)
      await new Promise<void>((resolve) => {
        releaseRetention = resolve;
      });
    e.retainedPublicHandState = JSON.parse(batch.controller).state;
  };
  const controller = e.handController;
  const started = e.runOriginalController(roster, controller, 42, Date.now(), {
    started: false,
    cause: null,
  });
  try {
    await vi.waitFor(() => expect(e.handContinuation).toBeTruthy());
    await e.handContinuation.join();
    const decision = e.getActionContext();
    expect(decision).toBeTruthy();
    const actualHandler = (ServerTableEngine.prototype as any).handleHandEvent;
    let dispatched = false;
    e.handleHandEvent = async (...args: any[]) => {
      if (dispatched && args[3] !== true) return;
      dispatched = true;
      await actualHandler.apply(e, args);
    };
    let release!: () => void;
    let settling = false;
    e.sleep = async () => {
      settling = true;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    };
    const timer = vi.spyOn(e, 'startTurnTimer');
    e.handContinuation.enqueue({
      type: 'TURN_CHANGE',
      seat: controller.getState().currentPlayerSeat,
      availableActions: [],
    });
    await vi.waitFor(() => expect(settling).toBe(true));
    expect(e.getActionContext()).toBe(decision);
    delayRetention = mode.startsWith('delayed');
    e.handContinuation.checkpoint();
    expect(e.getTableState('u1').action_context).toBeNull();
    if (mode === 'changed') {
      expect(controller.performAction(controller.getState().currentPlayerSeat, 'call')).toBe(true);
      expect(playerActionContext(controller)).not.toBe(decision);
    }
    if (mode === 'stopped') e.running = false;
    release();
    if (mode.startsWith('delayed')) {
      await vi.waitFor(() => expect(releaseRetention).toBeTypeOf('function'));
      expect(e.getActionContext()).toBeNull();
      expect(timer).not.toHaveBeenCalled();
      now += 60_000;
      scheduler.tickNow();
      expect(
        controller
          .getState()
          .actionHistory.filter((entry: any) => !['sb', 'bb', 'ante'].includes(entry.action))
      ).toEqual([]);
      if (mode === 'delayed_changed')
        expect(controller.performAction(controller.getState().currentPlayerSeat, 'call')).toBe(
          true
        );
      if (mode === 'delayed_stopped') e.running = false;
      delayRetention = false;
      releaseRetention!();
    }
    if (mode === 'stopped' || mode === 'delayed_stopped')
      await expect(e.handContinuation.join()).rejects.toThrow();
    else await e.handContinuation.join();
    if (
      mode === 'changed' ||
      mode === 'stopped' ||
      mode === 'delayed_changed' ||
      mode === 'delayed_stopped'
    ) {
      expect(timer).not.toHaveBeenCalled();
      return;
    }
    expect(e.getActionContext()).toBe(decision);
    expect(timer).toHaveBeenCalledTimes(1);
    expect(e.preciseTimer.hasTimer(e.tableId, 'u' + controller.getState().currentPlayerSeat)).toBe(
      true
    );
    expect(
      e.currentHandTimerLog.filter((entry: any) => entry.event === 'timer_start')
    ).toHaveLength(1);
    const turnFrames = e.hub.emitEvent.mock.calls
      .map((call: any[]) => call[1])
      .filter((frame: any) => frame.type === 'turn_change');
    expect(turnFrames).toHaveLength(1);
    expect(turnFrames[0].action_context).toBe(decision);
    const action = mode === 'delayed_fold' ? 'fold' : mode === 'delayed_raise' ? 'raise' : 'call';
    originalAuth.userId = 'u' + controller.getState().currentPlayerSeat;
    expect(e.preciseTimer.getRemainingMs(e.tableId, originalAuth.userId)).toBeGreaterThanOrEqual(
      e.playerTurnDuration * 1000
    );
    let status = 0;
    let body = '';
    const res = {
      writeHead: (code: number) => {
        status = code;
        return res;
      },
      end: (value?: string) => {
        body = value ?? '';
      },
    };
    __resetRateLimiterForTests();
    await handleAction(
      {
        __body: JSON.stringify({
          tableId: config.tableId,
          action,
          ...(action === 'raise' ? { amount: 40 } : {}),
          actionContext: decision,
          idempotencyKey: `settle-retained-${mode}`,
        }),
      } as never,
      res as never,
      { gameServer: { getTableEngine: () => e } }
    );
    expect({ status, body: JSON.parse(body) }).toMatchObject({
      status: 200,
      body: { success: true },
    });
    await e.handContinuation.join();
    expect(
      controller.getState().actionHistory.filter((entry: any) => entry.action === action)
    ).toHaveLength(1);
  } finally {
    delayRetention = false;
    releaseRetention?.();
    scheduler.stop();
    e.running = false;
    e.activeHandWaitRelease?.release('test_cleanup');
    await started;
  }
});

it.each([
  'ready_fold',
  'ready_call',
  'ready_raise',
  'weekly_first',
  'retention_first',
  'changed',
  'stopped',
  'rearmed',
  'failed',
  'concurrent',
  'concurrent_late',
] as const)(
  'preserves the primary clock while its bank-arm intent is unretained: %s',
  async (mode) => {
    const { e, roster } = fixture();
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    delete e.clearTurnTimer;
    const scheduler = new DeadlineScheduler({ now: () => now });
    // Preserve the one shared timer instance used by bank and disconnect engines.
    e.preciseTimer.scheduler = scheduler;
    e.preciseTimer.now = () => now;
    scheduler.stop();
    e.tableInfo = { game_variant: 'nlh', big_blind: 20, small_blind: 10, max_players: 2 };
    e.hub = { publish: vi.fn(), emitEvent: vi.fn() };
    let blocked = false;
    let release: (() => void) | undefined;
    let retainedCapture: any;
    e.retainOriginalBatch = async (_o: unknown, _s: unknown, batch: any) => {
      if (blocked) {
        retainedCapture = structuredClone(batch.engine);
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        if (mode === 'failed') throw Error('retention outcome unavailable');
      }
      e.retainedPublicHandState = JSON.parse(batch.controller).state;
    };
    const controller = e.handController;
    const started = e.runOriginalController(roster, controller, 42, Date.now(), {
      started: false,
      cause: null,
    });
    let armed: Promise<unknown> | undefined;
    let duplicate: Promise<unknown> | undefined;
    try {
      await vi.waitFor(() => expect(e.handContinuation).toBeTruthy());
      await e.handContinuation.join();
      const seat = controller.getState().currentPlayerSeat;
      const user = 'u' + seat;
      await e.handleTurnChange({ type: 'TURN_CHANGE', seat, availableActions: [] }, roster);
      const uses = e.timeBankEngine.getUsesRemaining(e.tableId, user);
      expect(e.preciseTimer.hasTimer(e.tableId, user)).toBe(true);
      now += 5_000;
      const remaining = e.preciseTimer.getRemainingMs(e.tableId, user);
      blocked = true;
      armed = e.activateTimeBank(user);
      void armed!.catch(() => {});
      if (mode === 'concurrent') {
        duplicate = e.activateTimeBank(user);
        void duplicate!.catch(() => {});
      }
      await vi.waitFor(() => expect(release).toBeTypeOf('function'));
      expect(e.getActionContext()).toBeNull();
      expect(retainedCapture.timeBanks.find((entry: any) => entry.userId === user).bank.armed).toBe(
        true
      );
      expect(JSON.stringify(retainedCapture)).not.toContain('bankArmRetentionHold');
      if (mode === 'weekly_first' || mode === 'retention_first') {
        now += 10_000;
        e.pauseForWeeklyPayout('test-weekly');
        e.engageWeeklyPayoutHandPause('test-weekly');
        now += 20_000;
        if (mode === 'weekly_first') e.resumeFromWeeklyPayout('test-weekly');
      }
      if (mode === 'rearmed') {
        now += 10_000;
        e.startTurnTimer(user, seat, 15);
      }
      now += 60_000;
      scheduler.tickNow();
      if (mode === 'concurrent_late') {
        duplicate = e.activateTimeBank(user);
        void duplicate!.catch(() => {});
      }
      expect(e.timeBankEngine.getUsesRemaining(e.tableId, user)).toBe(uses);
      expect(
        controller
          .getState()
          .actionHistory.filter((entry: any) => !['sb', 'bb', 'ante'].includes(entry.action))
      ).toEqual([]);
      if (mode === 'changed') expect(controller.performAction(seat, 'call')).toBe(true);
      if (mode === 'stopped') e.running = false;
      blocked = false;
      release!();
      if (mode === 'stopped' || mode === 'failed') await expect(armed).rejects.toThrow();
      else await armed;
      await duplicate;
      if (mode === 'changed' || mode === 'stopped' || mode === 'failed') {
        expect(e.preciseTimer.hasTimer(e.tableId, user)).toBe(false);
        return;
      }
      if (mode === 'retention_first') {
        const heldRemaining = e.preciseTimer.getRemainingMs(e.tableId, user);
        now += 20_000;
        scheduler.tickNow();
        expect(e.preciseTimer.getRemainingMs(e.tableId, user)).toBe(heldRemaining);
        e.resumeFromWeeklyPayout('test-weekly');
      }
      expect(e.preciseTimer.getRemainingMs(e.tableId, user)).toBe(
        mode === 'rearmed' ? 17_000 : remaining
      );
      expect(e.playerTurnStartTime).toBe(now - (mode === 'rearmed' ? 0 : 5_000));
      expect(e.getActionContext()).toBeTruthy();
      expect(e.hub.publish.mock.calls.at(-1)[1].turn_deadline_ms).toBe(
        now + (mode === 'rearmed' ? 15_000 : 10_000)
      );
      const countdown = e.hub.emitEvent.mock.calls
        .map((call: any[]) => call[1])
        .filter((frame: any) => frame.type === 'timer_countdown')
        .at(-1);
      if (mode === 'retention_first') {
        // The weekly owner still holds the decision when retention completes.
        expect(countdown).toBeUndefined();
      } else {
        expect(countdown).toMatchObject({
          type: 'timer_countdown',
          table_id: e.tableId,
          player_id: user,
          seat,
          remaining_ms: mode === 'rearmed' ? 15_000 : 10_000,
        });
        // A weekly owner may still hold the clock after retention releases it;
        // its later resume republishes the same remaining duration at a new time.
        expect(countdown.timestamp + countdown.remaining_ms).toBe(
          e.hub.publish.mock.calls.findLast(
            (call: any[]) => call[1].server_time_ms === countdown.timestamp
          )[1].turn_deadline_ms
        );
      }
      if (mode.startsWith('ready_')) {
        const action = mode.slice(6);
        originalAuth.userId = user;
        let status = 0;
        let body = '';
        const res = {
          writeHead: (code: number) => {
            status = code;
            return res;
          },
          end: (value?: string) => {
            body = value ?? '';
          },
        };
        __resetRateLimiterForTests();
        await handleAction(
          {
            __body: JSON.stringify({
              tableId: config.tableId,
              action,
              ...(action === 'raise' ? { amount: 40 } : {}),
              actionContext: e.getActionContext(),
              idempotencyKey: `bank-retained-${mode}`,
            }),
          } as never,
          res as never,
          { gameServer: { getTableEngine: () => e } }
        );
        expect({ status, body: JSON.parse(body) }).toMatchObject({
          status: 200,
          body: { success: true },
        });
        await e.handContinuation.join();
        expect(
          controller.getState().actionHistory.filter((entry: any) => entry.action === action)
        ).toHaveLength(1);
      }
    } finally {
      blocked = false;
      release?.();
      scheduler.stop();
      e.running = false;
      e.activeHandWaitRelease?.release('test_cleanup');
      await armed?.catch(() => {});
      await duplicate?.catch(() => {});
      await started;
    }
  }
);
