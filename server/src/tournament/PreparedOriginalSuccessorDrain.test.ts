import { afterEach, expect, it, vi } from 'vitest';
import { TournamentManagerBase } from './TournamentManagerBase.js';
import { ServerTableEngine } from '../engine/ServerTableEngine.js';
import { HandController } from '../engine/HandController.js';
import type { GameServer } from '../GameServer.js';
import type { HandConfig, SeatPlayer } from '../types.js';

class Manager extends TournamentManagerBase {
  protected override startEliminationChecker(): void {}
  protected override async recalculateEliminatedPrizes(): Promise<boolean> {
    return true;
  }
}
const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const f of cleanup.splice(0)) f();
  vi.restoreAllMocks();
});
function fixture() {
  const tableId = 'aaaaaaaa-0000-4000-8000-000000000001';
  const event = 'aaaaaaaa-0000-4000-8000-000000000002';
  const handoff = vi.fn();
  const manager = new Manager(event, {
    handTournamentToSuccessorGeneration: handoff,
  } as unknown as GameServer) as any;
  manager.running = true;
  manager.tournamentLeaseAuthorityIsCurrent = () => true;
  const engine = new ServerTableEngine(tableId) as any;
  engine.running = true;
  engine.lifecycleCanMutate = () => true;
  engine.isCurrentEngine = () => true;
  const players = [1, 2].map((seat) => ({
    seat,
    user_id: `p${seat}`,
    username: `P${seat}`,
    stack: 100,
    bet: 0,
    totalInvested: 0,
    cards: [],
    is_folded: false,
    is_all_in: false,
    is_sitting_out: false,
  })) as SeatPlayer[];
  const controller = new HandController(
    {
      tableId,
      handNumber: 1,
      gameVariant: 'nlh',
      smallBlind: 1,
      bigBlind: 2,
      rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
    } as HandConfig,
    players,
    1
  );
  engine.handController = controller;
  engine.handCount = 1;
  const original = { hand_number: '1' };
  engine.f06CurrentPermit = { binding: original, recoveryState: () => 'attempted' };
  // The production marker accepts only exact positively retained sequence-zero bytes.
  engine.markRetainedPreparedOriginal(controller, original, {
    version: 1,
    sequence: 0,
    controller: controller.serializeRecoveryState(),
    events: [],
    engine: {},
  });
  manager.tableEngines.set(tableId, engine);
  manager.wireEliminationWake(engine);
  cleanup.push(() => {
    engine.running = false;
    engine.resumeDealing();
    engine.engineTelemetry.dispose();
  });
  return { manager, engine, controller, handoff };
}

it.each([false, true])(
  'hands off a durably prepared original at its actual park (claimed=%s)',
  async (claimed) => {
    const { manager, engine, controller, handoff } = fixture();
    if (claimed)
      engine.pendingOriginalContinuation = {
        original: engine.f06CurrentPermit.binding,
        batch: { sequence: 0, events: [], controller: controller.serializeRecoveryState() },
      };
    manager.requestSuccessorDrain();
    expect(handoff).not.toHaveBeenCalled();
    const parked = engine.awaitPauseGate();
    expect(engine.isBetweenHands()).toBe(false);
    expect(JSON.parse(controller.serializeRecoveryState()).handStarted).toBe(false);
    expect(handoff).toHaveBeenCalledTimes(1);
    manager.completeSuccessorDrain();
    expect(handoff).toHaveBeenCalledTimes(1);
    engine.running = false;
    engine.resumeDealing();
    await parked;
  }
);

it.each([
  'started',
  'unconfirmed',
  'wrong-controller',
  'settling',
  'read-pending',
  'owner-lost',
  'permit-replaced',
  'permit-missing',
] as const)('does not hand off a %s original as an idle hand', async (scenario) => {
  const { manager, engine, controller, handoff } = fixture();
  if (scenario === 'started') controller.start();
  if (scenario === 'unconfirmed') engine.preparedOriginalRetentionUnconfirmed = true;
  if (scenario === 'wrong-controller') engine.retainedPreparedOriginalController = null;
  if (scenario === 'settling') engine.postHandTasksPromise = Promise.resolve();
  if (scenario === 'read-pending') engine.readContinuationTasks.add(Promise.resolve());
  if (scenario === 'owner-lost') engine.lifecycleCanMutate = () => false;
  if (scenario === 'permit-replaced') engine.f06CurrentPermit.binding = { hand_number: '2' };
  if (scenario === 'permit-missing') engine.f06CurrentPermit = null;
  manager.requestSuccessorDrain();
  const parked = engine.awaitPauseGate();
  manager.completeSuccessorDrain();
  expect(handoff).not.toHaveBeenCalled();
  engine.running = false;
  engine.resumeDealing();
  await parked;
});
