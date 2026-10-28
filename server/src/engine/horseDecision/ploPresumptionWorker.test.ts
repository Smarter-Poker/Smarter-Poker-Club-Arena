/** Shared Omaha presumption through the actual worker. Owner update 2026-10-27:
 * public evidence and game context drive the same strategy for all opponents. */
import { afterEach, expect, it, vi } from 'vitest';
import { HandController } from '../HandController.js';
import { HorseMind } from '../HorseMind.js';
import {
  defaultHorseDecisionWorkerDependencies as defaults,
  HorseDecisionWorkerRuntime,
} from './workerRuntime.js';
import type { HorseDecisionWorkerResponse } from './protocol.js';
import type { HandConfig, SeatPlayer } from '../../types.js';
import { controllerDecisionState } from '../remainingVariants/RemainingVariantControllerSpots.test-support.js';
import { buildHorseDecisionKey } from './protocol.js';
import { captureHorseHandJournalContext } from '../HorseDecisionHandBinding.js';
import { applyTableCommitmentCap } from '../ServerTableEngineTurns.js';

const table = '10000000-0000-4000-8000-000000000001';
const person = '20000000-0000-4000-8000-000000000001';
const hero = '20000000-0000-4000-8000-000000000002';
afterEach(() => {
  vi.restoreAllMocks();
  HorseMind.reset();
});

it.each([[true], [false]])(
  'any never-seen opponent who opens receives the shared aggressive read through the worker (roster %s)',
  async (withRoster) => {
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
    const config: HandConfig = {
      tableId: table,
      handNumber: 1000140,
      gameVariant: 'plo4',
      smallBlind: 1,
      bigBlind: 2,
      isTournament: false,
      rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
    } as HandConfig;
    const players = [person, hero].map((user_id, i) => ({
      seat: i + 1,
      user_id,
      username: `A${i}`,
      stack: 1000,
      bet: 0,
      totalInvested: 0,
      cards: [],
      is_folded: false,
      is_all_in: false,
      is_sitting_out: false,
    })) as SeatPlayer[];
    const controller = new HandController(config, players, 1);
    controller.start();
    expect(controller.performAction(1, 'raise', 6)).toBe(true);
    const spot = controllerDecisionState(controller, 'plo4' as never, 'cash', config)!;
    expect(spot.hero.user_id).toBe(hero);
    spot.state.commitmentCapRemaining = applyTableCommitmentCap(
      controller.getAuthoritativeActionState(hero)!,
      spot.hero,
      false,
      0,
      2
    ).commitmentCapRemaining;
    if (withRoster) (spot.state as any).humanUserIds = [person];
    const reads: any[] = [];
    const real = HorseMind.opponentRead.bind(HorseMind);
    vi.spyOn(HorseMind, 'opponentRead').mockImplementation((id: string) => {
      const r = real(id);
      if (id === person) reads.push(r);
      return r;
    });
    const request = {
      type: 'DECIDE_FAST' as const,
      requestId: 100,
      generation: 1,
      fence: `${table}:1000140:2:9:1`,
      decisionKey: '',
      decisionTimeMs: Date.now() + 10000,
      player: spot.hero,
      gameState: spot.state,
      style: 'balanced' as const,
      mods: {},
      handJournalContext: captureHorseHandJournalContext(spot.state.actionHistory!),
    };
    request.decisionKey = buildHorseDecisionKey(request);
    worker.receive(request);
    await worker.drain();
    const result = messages.find((m) => m.type === 'FAST_RESULT');
    expect(result?.type, JSON.stringify(messages.at(-1))).toBe('FAST_RESULT');
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((r) => r?.presumed === true && r.stats.pfr.engaged === 'high')).toBe(true);
  }
);
