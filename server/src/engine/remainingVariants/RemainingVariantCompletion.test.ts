import { describe, expect, it } from 'vitest';
import { HandController } from '../HandController.js';
import { remainingVariantSpot } from '../../benchmark/RemainingVariantPolicyEvidence.js';
import { variantEquityFromShowdowns } from '../omaha/OmahaVariantEquity.js';
import { evaluateRemainingVariantPolicy } from './RemainingVariantLivePolicy.js';

describe.each(['flh', 'flo8'] as const)(
  '%s policy consumes actual completion bounds',
  (variant) => {
    it.each([1, 5, 9.99, 10, 15, 19.99])(
      'prices and executes a raise after a short opening %s',
      (short) => {
        const spot = remainingVariantSpot(variant, 'flop', 3);
        const players = spot.state.players.map((p, i) => ({
          ...p,
          stack: i === 1 ? 20 + short : 500,
          bet: 0,
          totalInvested: 0,
        }));
        const hc = new HandController(
          {
            tableId: 'phase12-limit-completion',
            handNumber: 1,
            gameVariant: variant,
            smallBlind: 10,
            bigBlind: 20,
            rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
          },
          players,
          1
        );
        hc.start();
        for (const action of ['call', 'call', 'check'] as const)
          expect(hc.performAction(hc.getState().currentPlayerSeat!, action)).toBe(true);
        expect(hc.performAction(2, 'all_in')).toBe(true);
        const actual = hc.getState();
        const hero = actual.players.find((p) => p.seat === 3)!;
        const bounds = hc.getAuthoritativeActionState(hero.user_id)!;
        const state = {
          ...spot.state,
          ...actual,
          stateSchemaVersion: 1 as const,
          gameVariant: variant,
          bigBlind: 20,
          dealerSeat: 1,
          players: actual.players.map((p) => ({ ...p, cards: [] })),
          ...bounds,
          bettingStructure: bounds.structure,
          rakeConfig: hc.getRakeConfigSnapshot(),
        };
        const opponentIds = state.players
          .filter((p) => p.user_id !== hero.user_id && !p.is_folded)
          .map((p) => p.user_id);
        const evidence = variantEquityFromShowdowns({
          variant,
          players: state.players,
          heroId: hero.user_id,
          callCost: bounds.toCall,
          opponentIds,
          samples: Array.from({ length: 16 }, () => ({
            heroHigh: 2,
            heroLow: null,
            opponentHigh: opponentIds.map(() => 1),
            opponentLow: opponentIds.map(() => null),
            opponentDecisionStrength: opponentIds.map(() => 0.5),
          })),
        })!;
        evidence.analysisMs = 0;
        const result = evaluateRemainingVariantPolicy(
          hero,
          state,
          { action: 'call', thinkTime: 0 },
          evidence,
          'candidate',
          () => 0,
          1,
          false
        );
        expect(result.receipt.fired, result.receipt.reason).toBe(true);
        expect(result.proposal.action).toBe('raise');
        expect(result.proposal.amount).toBeCloseTo(short < 10 ? 20 : short + 20, 2);
        expect(hc.performAction(3, result.proposal.action, result.proposal.amount)).toBe(true);
      }
    );
  }
);
