import { afterEach, expect, it } from 'vitest';
import { HandController } from '../HandController.js';
import { HorseMind, readScopeOf } from '../HorseMind.js';
import { defaultHorseDecisionWorkerDependencies as defaults, HorseDecisionWorkerRuntime } from './workerRuntime.js';
import type { HorseDecisionWorkerResponse } from './protocol.js';
import type { ActionRecord, HandConfig, SeatPlayer } from '../../types.js';

const table = '10000000-0000-4000-8000-000000000001';
const opponent = '20000000-0000-4000-8000-000000000001';
const hero = '20000000-0000-4000-8000-000000000002';
afterEach(() => HorseMind.reset());

it.each(['open', 'limp_reraise'] as const)('learns a controller accepted %s as both VPIP and PFR through the worker', async (line) => {
  HorseMind.reset();
  const messages: HorseDecisionWorkerResponse[] = [];
  const worker = new HorseDecisionWorkerRuntime((m) => messages.push(m), {
    ...defaults,
    startServices: async () => defaults.workerReadiness(),
    stopServices: async () => {},
    journalEnabled: () => false,
    journalAcceptedHand: () => {},
    journalLifecycle: () => {},
    admitPhase8Authority: undefined,
    admitPhase10Authority: undefined,
    admitPhase11Authority: undefined,
    admitPhase12Authority: undefined,
    admitPhase13Authority: undefined,
    noteFeature: () => {},
    noteDecision: () => {},
  });
  await worker.start();
  let lastActions: ActionRecord[] = [];
  let lastPlayers: SeatPlayer[] = [];
  for (let h = 0; h < 30; h++) {
    const handNumber = 1000000 + h;
    const config: HandConfig = { tableId: table, handNumber, gameVariant: 'flh', smallBlind: 1, bigBlind: 2, isTournament: false, rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true } };
    const players = [opponent, hero].map((user_id, i) => ({ seat: i + 1, user_id, username: `Actor ${i + 1}`, stack: 100, bet: 0, totalInvested: 0, cards: [], is_folded: false, is_all_in: false, is_sitting_out: false })) as SeatPlayer[];
    const controller = new HandController(config, players, 1);
    controller.start();
    expect(controller.getState().currentPlayerSeat).toBe(1);
    if (line === 'limp_reraise') {
      expect(controller.performAction(1, 'call')).toBe(true);
      const raise = controller.getAuthoritativeActionState(hero)!;
      expect(controller.performAction(2, 'raise', raise.minRaiseTo!)).toBe(true);
    }
    const raise = controller.getAuthoritativeActionState(opponent)!;
    expect(controller.performAction(1, 'raise', raise.minRaiseTo!)).toBe(true);
    expect(controller.performAction(2, 'fold')).toBe(true);
    lastActions = controller.getState().actionHistory;
    lastPlayers = controller.getState().players;
    const observation = { type: 'OBSERVE_COMPLETED_HAND' as const, requestId: h * 2 + 1, generation: handNumber, fence: `${table}:${handNumber}:9:observe`, handKey: `${table}:${handNumber}`, committedHandId: `30000000-0000-4000-8000-${String(h + 1).padStart(12, '0')}`, actions: lastActions, bigBlind: 2, showdown: null, scope: readScopeOf('flh', 2) };
    worker.receive(observation);
    worker.receive({ ...observation, requestId: h * 2 + 2 });
    await worker.drain();
    expect(messages.at(-1)).toMatchObject({ type: 'ACK', operation: 'OBSERVE_COMPLETED_HAND' });
  }
  expect(HorseMind.getStats(opponent)).toMatchObject({ hands: 30, vpip: 30, pfr: 30, threeBet: line === 'limp_reraise' ? 30 : 0 });
  const scoped = HorseMind.snapshotDecisionReads(lastPlayers, null).scoped.get(`${readScopeOf('flh', 2)}|${opponent}`);
  expect(scoped).toMatchObject({ hands: 30, vpip: 30, pfr: 30 });
  HorseMind.setDecisionScope(readScopeOf('flh', 2));
  const learned = HorseMind.bandFor(opponent, lastActions, 2, false);
  HorseMind.reset();
  const prior = HorseMind.bandFor(opponent, lastActions, 2, false);
  expect(learned).not.toBeNull();
  expect(learned![0]).toBeCloseTo(prior![0] - 0.1, 10);
});
