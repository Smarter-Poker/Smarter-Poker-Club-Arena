import { describe, expect, it } from 'vitest';
import {
  buildPressureWarmRecords,
  makeFeatureAblationOwnHistory,
  featureAblationPlayerId,
  featureAblationHistoryDigest,
  FEATURE_ABLATION_HISTORY_AVAILABLE_AT_MS as AVAILABLE,
} from './FeatureAblationHistory.js';
import { ownPublicHistoryIsValid } from '../engine/horseDecision/ownPublicHistory.js';
import { HorseObserverReads } from '../engine/horseDecision/observerReads.js';
import { HorseMind, readScopeOf } from '../engine/HorseMind.js';
import { captureHorseHandJournalContext } from '../engine/HorseDecisionHandBinding.js';
import { buildHorseDecisionKey } from '../engine/horseDecision/protocol.js';
import { decisionRequest, heroId, opponentId } from '../testing/horseRegression/plan/fixture.js';
import type { HorseObserverReadContext } from '../engine/HorseObserverReadContext.js';
const context = (
  variant: HorseObserverReadContext['variant'] = 'nlh',
  dealtCount = 2
): HorseObserverReadContext => ({
  version: 1,
  observerId: featureAblationPlayerId(1),
  variant,
  format: 'cash',
  dealtCount,
});

describe('offline history follows the original public packet and internal observer path', () => {
  it.each(['nlh', 'plo5'] as const)(
    '%s warm histories are actual accepted local hands and carry no cards',
    (variant) => {
      const records = buildPressureWarmRecords({ variant, seats: 2, seed: 24301101 });
      const packet = makeFeatureAblationOwnHistory(context(variant), 1, records);
      expect(records).toHaveLength(48);
      expect(Object.isFrozen(records)).toBe(true);
      expect(ownPublicHistoryIsValid(packet, context(variant), AVAILABLE)).toBe(true);
      expect(JSON.stringify(packet)).not.toMatch(/cards|showdown|counters|donor|policy|authority/);
      expect(packet.hands.every((h) => h.handNumber >= 1000000 && h.actions.length > 0)).toBe(true);
      expect(featureAblationHistoryDigest(records)).toMatch(/^[a-f0-9]{64}$/);
    }
  );
  it.each(['nlh', 'plo4', 'plo5', 'plo6'] as const)(
    '%s all declared dealt counts fit original packet bounds for every observer',
    (variant) => {
      for (const seats of [2, 4, 6]) {
        const records = buildPressureWarmRecords({ variant, seats, seed: 24301101 });
        for (let seat = 1; seat <= seats; seat++) {
          const c = { ...context(variant, seats), observerId: featureAblationPlayerId(seat) };
          expect(
            ownPublicHistoryIsValid(makeFeatureAblationOwnHistory(c, seat, records), c, AVAILABLE)
          ).toBe(true);
        }
      }
    }
  );
  it('is deterministic on the declared development warm stream', () => {
    const input = { variant: 'nlh' as const, seats: 2, seed: 24301101 };
    expect(featureAblationHistoryDigest(buildPressureWarmRecords(input))).toBe(
      featureAblationHistoryDigest(buildPressureWarmRecords(input))
    );
  });
  it('builds an explicit empty available window for a declared cold-read domain', () => {
    const packet = makeFeatureAblationOwnHistory(context(), 1);
    expect(packet.hands).toEqual([]);
    expect(ownPublicHistoryIsValid(packet, context(), AVAILABLE)).toBe(true);
  });
  it('refuses wrong observer, context and future cutoff', () => {
    const records = buildPressureWarmRecords({ variant: 'nlh', seats: 2, seed: 24301101 });
    expect(() => makeFeatureAblationOwnHistory(context(), 2, records)).toThrow(/physical seat/);
    expect(() => makeFeatureAblationOwnHistory(context('plo5'), 1, records)).toThrow(
      /validator refused/
    );
    const packet = makeFeatureAblationOwnHistory(context(), 1, records);
    expect(ownPublicHistoryIsValid(packet, context(), AVAILABLE - 1)).toBe(false);
  });
  it('hydrates public observations through HorseObserverReads without direct counter injection', () => {
    const records = buildPressureWarmRecords({ variant: 'nlh', seats: 2, seed: 24301101 });
    const request = decisionRequest();
    const ids = new Map([
      [heroId, featureAblationPlayerId(1)],
      [opponentId, featureAblationPlayerId(2)],
    ]);
    request.player = { ...request.player, user_id: featureAblationPlayerId(1) };
    request.gameState = {
      ...request.gameState,
      players: request.gameState.players.map((p) => ({ ...p, user_id: ids.get(p.user_id)! })),
      actionHistory: request.gameState.actionHistory!.map((a) => ({
        ...a,
        userId: ids.get(a.userId)!,
      })),
      pots: [
        { amount: 12, eligiblePlayers: [featureAblationPlayerId(1), featureAblationPlayerId(2)] },
      ],
    };
    request.decisionTimeMs = AVAILABLE + 1000;
    request.handJournalContext = captureHorseHandJournalContext(request.gameState.actionHistory!);
    request.ownPublicHistoryState = 'available';
    request.ownPublicHistory = makeFeatureAblationOwnHistory(context(), 1, records);
    request.decisionKey = buildHorseDecisionKey(request);
    const bank = new HorseObserverReads();
    bank.run(request, () => {
      const observed = records.filter((h) =>
        h.actions.some((a) => a.userId === featureAblationPlayerId(2))
      ).length;
      expect(observed).toBeGreaterThanOrEqual(40);
      expect(HorseMind.getStats(featureAblationPlayerId(2))?.hands).toBe(observed);
      const counters = HorseMind.getExploitCounters(
        featureAblationPlayerId(2),
        readScopeOf('nlh', 2)
      );
      expect(counters?.hands).toBeGreaterThan(0);
      expect(counters?.pfr).toBeGreaterThan(0);
    });
    expect(bank.receipt(request)).toMatchObject({
      version: 2,
      history: 'own_public_window',
      historyHands: 48,
    });
    expect(HorseMind.getStats(featureAblationPlayerId(2))).toBeUndefined();
  });
});
