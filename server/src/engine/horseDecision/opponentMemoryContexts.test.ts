import { afterEach, expect, it } from 'vitest';
import { applyTableCommitmentCap } from '../ServerTableEngineTurns.js';
import { HandController } from '../HandController.js';
import { HorseMind, readScopeOf } from '../HorseMind.js';
import {
  decayAndAdd,
  exploitHandIncrements,
  freshExploitCounters,
} from '../HorseOpponentExploit.js';
import {
  MEMORY_VARIANTS,
  validOpponentDonorProfiles,
  type DurableOpponentProfile,
} from '../HorseOpponentMemory.js';
import {
  decodeHorseDecisionReads,
  type HorseDecisionReadFrame,
} from '../HorseDecisionReadFrame.js';
import { controllerDecisionState } from '../remainingVariants/RemainingVariantControllerSpots.test-support.js';
import { captureHorseHandJournalContext } from '../HorseDecisionHandBinding.js';
import { buildHorseDecisionKey, type HorseDecisionWorkerResponse } from './protocol.js';
import {
  defaultHorseDecisionWorkerDependencies as defaults,
  HorseDecisionWorkerRuntime,
} from './workerRuntime.js';
import type { HandConfig, SeatPlayer } from '../../types.js';
import type { HorsePlanContext } from '../HorsePlanHandIdentity.js';
const table = '11000000-0000-4000-8000-000000000001';
const ids = Array.from(
  { length: 6 },
  (_, i) => `21000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`
);
function donor(variant: DurableOpponentProfile['variant']): DurableOpponentProfile {
  const counters = freshExploitCounters();
  const increment = exploitHandIncrements([
    { userId: ids[1], action: 'raise', stage: 'preflop' },
  ]).get(ids[1])!;
  for (let h = 0; h < 60; h++) decayAndAdd(counters, increment);
  return {
    user_id: ids[1],
    variant,
    mode: 'cash',
    size: 'short',
    initialized: true,
    observed_hands: 60,
    counters,
  };
}
afterEach(() => HorseMind.reset());
it('canonical variants remain distinct and donor batches keep the ten actor boundary', () => {
  expect(MEMORY_VARIANTS).toEqual([
    'nlh',
    'plo4',
    'plo5',
    'plo6',
    'plo8',
    'flh',
    'flo8',
    'short_deck',
  ]);
  expect(validOpponentDonorProfiles([donor('flh')], ids, 'nlh', 'cash', 'full')).toBe(false);
  expect(validOpponentDonorProfiles([donor('flo8')], ids, 'plo8', 'cash', 'full')).toBe(false);
  expect(validOpponentDonorProfiles([donor('flh')], ids, 'flh', 'tournament', 'full')).toBe(false);
  expect(validOpponentDonorProfiles([donor('flh')], ids, 'flh', 'cash', 'hu')).toBe(false);
  expect(
    validOpponentDonorProfiles(
      Array.from({ length: 11 }, () => donor('flh')),
      ids,
      'flh',
      'cash',
      'full'
    )
  ).toBe(false);
});
it.each(['flh', 'flo8', 'short_deck'] as const)(
  'first %s FAST after restart refuses pooled donor and preserves independent second look',
  async (variant) => {
    HorseMind.reset();
    const messages: HorseDecisionWorkerResponse[] = [];
    const captures: Array<{
      readFrame: HorseDecisionReadFrame | null;
      planContext: HorsePlanContext;
    }> = [];
    const worker = new HorseDecisionWorkerRuntime((m) => messages.push(m), {
      ...defaults,
      startServices: async () => defaults.workerReadiness(),
      stopServices: async () => {},
      journalEnabled: () => true,
      journalDecision: (_request, captured) => {
        captures.push(captured as (typeof captures)[number]);
      },
      journalAcceptedHand: () => {},
      journalLifecycle: () => {},
      sourceRelease: () => null,
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
      handNumber: 1000001,
      gameVariant: variant,
      smallBlind: 1,
      bigBlind: 2,
      isTournament: false,
      rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
    };
    const players = ids.map((user_id, i) => ({
      seat: i + 1,
      user_id,
      username: 'Actor',
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
    const spot = controllerDecisionState(controller, variant, 'cash', config)!;
    spot.state.commitmentCapRemaining = applyTableCommitmentCap(
      controller.getAuthoritativeActionState(spot.hero.user_id)!,
      spot.hero,
      false,
      0,
      config.bigBlind
    ).commitmentCapRemaining;
    const request = {
      type: 'DECIDE_FAST' as const,
      requestId: 1,
      generation: 1,
      fence: `${table}:1000001:${spot.hero.seat}:9:1`,
      decisionKey: '',
      decisionTimeMs: 1700000000000,
      player: spot.hero,
      gameState: spot.state,
      style: 'balanced' as const,
      mods: {},
      handJournalContext: captureHorseHandJournalContext(spot.state.actionHistory!),
      durableOpponentProfiles: [],
      durableOpponentDonorProfiles: [donor(variant)],
    };
    request.decisionKey = buildHorseDecisionKey(request);
    worker.receive(request);
    await worker.drain();
    expect(
      messages.some((m) => m.type === 'FAST_RESULT'),
      JSON.stringify(messages.at(-1))
    ).toBe(true);
    expect(captures).toHaveLength(1);
    expect(captures[0].readFrame).not.toBeNull();
    HorseMind.setDecisionScope(readScopeOf(variant, 6), variant, 'cash');
    const first = HorseMind.opponentRead(ids[1]);
    expect(first).toBeNull();
    const frame = captures[0].readFrame!;
    const view = decodeHorseDecisionReads(
      frame,
      spot.state.players,
      JSON.parse(frame.json).handKey,
      captures[0].planContext
    );
    HorseMind.runInSandbox(view, () => {
      HorseMind.setDecisionScope(readScopeOf(variant, 6), variant, 'cash');
      expect(HorseMind.opponentRead(ids[1])).toEqual(first);
    });
    HorseMind.setDecisionScope(
      readScopeOf(variant, 6),
      variant === 'flh' ? 'nlh' : variant === 'flo8' ? 'plo8' : 'nlh',
      'cash'
    );
    expect(HorseMind.opponentRead(ids[1])).toBeNull();
  }
);
