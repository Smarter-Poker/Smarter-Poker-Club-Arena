import { afterEach, expect, it, vi } from 'vitest';
import { HorseMind } from '../HorseMind.js';
import {
  WINNER_BLUFF_MOD,
  WINNER_VALUE_THIN_MOD,
  resetWinnerReads,
  winnerReadout,
} from '../HorseWinnerRead.js';
import { buildLightningObservation } from '../../lightning/LightningHorseObservation.js';
import {
  defaultHorseDecisionWorkerDependencies as defaults,
  HorseDecisionWorkerRuntime,
} from './workerRuntime.js';
import type { HorseDecisionWorkerResponse } from './protocol.js';

const table = '10000000-0000-4000-8000-000000000001';
const winner = '20000000-0000-4000-8000-000000000001';
const loser = '20000000-0000-4000-8000-000000000002';

afterEach(() => {
  HorseMind.reset();
  resetWinnerReads();
  vi.restoreAllMocks();
});

it.each([true, false])(
  'Lightning committed results reach the %s owning worker and its exploit profile once',
  async (owns) => {
    HorseMind.reset();
    resetWinnerReads();
    const messages: HorseDecisionWorkerResponse[] = [];
    const worker = new HorseDecisionWorkerRuntime((message) => messages.push(message), {
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
      ownsCompletedHand: () => owns,
      noteFeature: () => {},
      noteDecision: () => {},
    });
    await worker.start();
    const baseline = HorseMind.exploit(winner);
    for (let hand = 0; hand < 400; hand++) {
      // Public settlement amounts only: neither hole cards nor horse identity is
      // needed to identify the same winning result in the real worker consumer.
      const observation = buildLightningObservation(
        {
          hostTableId: table,
          handNumber: 1_000_000 + hand,
          leaseGeneration: 'test-generation',
          handHistoryId: `30000000-0000-4000-8000-${String(hand + 1).padStart(12, '0')}`,
          variant: 'plo5',
          bigBlind: 2,
          dealtCount: 2,
          actions: [],
          showdown: [],
          results: [
            { playerId: winner, contributed: 2, won: 4 },
            { playerId: loser, contributed: 2, won: 0 },
          ],
        },
        undefined
      );
      expect(observation.results).toEqual([
        { user_id: winner, net: 2 },
        { user_id: loser, net: -2 },
      ]);
      expect(JSON.stringify(observation)).not.toMatch(/is_horse|holeCards|"cards"/);
      const request = {
        ...observation,
        type: 'OBSERVE_COMPLETED_HAND' as const,
        requestId: hand * 2 + 1,
      };
      worker.receive(request);
      await worker.drain();
      const beforeDuplicate = winnerReadout(winner);
      worker.receive({ ...request, requestId: hand * 2 + 2 });
      await worker.drain();
      expect(winnerReadout(winner)).toEqual(beforeDuplicate);
      expect(messages.at(-1)).toMatchObject({ type: 'ACK', operation: 'OBSERVE_COMPLETED_HAND' });
      if (hand === 199) expect(winnerReadout(winner)?.proven).toBe(false);
    }
    expect(winnerReadout(winner)).toMatchObject({ meanBB: 1, proven: true });
    expect(winnerReadout(winner)!.effectiveHands).toBeGreaterThan(300);
    expect(winnerReadout(loser)?.proven).toBe(false);
    expect(HorseMind.exploit(winner)).toEqual({
      bluffMod: baseline.bluffMod * WINNER_BLUFF_MOD,
      callDownMod: baseline.callDownMod,
      valueThinMod: Math.min(baseline.valueThinMod, WINNER_VALUE_THIN_MOD),
    });
    expect(HorseMind.exploit(loser)).toEqual(baseline);
  }
);
