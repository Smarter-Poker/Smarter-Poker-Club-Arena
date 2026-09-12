import { describe, expect, it } from 'vitest';
import { HandController } from '../HandController.js';
import { KNOWN_VARIANTS, horseVariantRulesFor, maxSeatsFor } from '../VariantRules.js';
import { maxSeatsForVariant } from '../../config/tableSeating.js';
import { jointPolicyFixture } from './JointRangeFixture.test-support.js';
import { evaluateJointLivePolicy } from './JointLivePolicy.js';
import { HorseLogic } from '../HorseLogic.js';
import type { GameVariant, SeatPlayer } from '../../types.js';

describe('Phase13 actual launch and board downgrade matrix', () => {
  it.each(KNOWN_VARIANTS as GameVariant[])(
    '%s honors actual board count, trigger, units, physical and product caps',
    (variant) => {
      for (const mode of ['cash', 'tournament'] as const) {
        if (variant === 'pineapple' && mode === 'tournament') continue;
        const seats =
          mode === 'cash' ? maxSeatsForVariant(variant) : Math.min(10, maxSeatsFor(variant));
        for (const requested of [1, 2, 3] as const)
          for (const trigger of ['every_n_hands', 'once_per_orbit', 'timed', 'bomb_pot_only']) {
            const players: SeatPlayer[] = Array.from({ length: seats }, (_, i) => ({
              seat: i + 1,
              user_id: 'launch-' + i,
              username: 'seat',
              stack: 200,
              bet: 0,
              totalInvested: 0,
              cards: [],
              is_folded: false,
              is_sitting_out: false,
              is_all_in: false,
            }));
            const controller = new HandController(
              {
                tableId: 'phase13-offline-launch',
                handNumber: 1,
                gameVariant: variant,
                smallBlind: 1,
                bigBlind: 2,
                isTournament: mode === 'tournament',
                asset: 'chips',
                rakeConfig: { percent: mode === 'cash' ? 10 : 0, cap: 2, noFlopNoDrop: true },
                bombPot: { boardCount: requested, anteMultiplier: 2, triggerReason: trigger },
              },
              players,
              seats
            );
            try {
              controller.start();
              if (variant === 'pineapple') {
                for (const player of controller
                  .getState()
                  .players.filter((p) => !p.is_folded && p.cards.length === 3))
                  expect(
                    controller.performDiscard(
                      player.seat,
                      HorseLogic.decideDiscard(
                        player.cards,
                        controller.getState().communityCards,
                        variant
                      )
                    )
                  ).toBe(true);
                controller.flushPineappleSettle();
              }
              const live = controller.getState(),
                hero = live.players.find((p) => p.seat === live.currentPlayerSeat)!;
              expect(hero).toBeDefined();
              const menu = controller.getAuthoritativeActionState(hero.user_id)!;
              const rules = horseVariantRulesFor(variant);
              const actual = Math.min(
                requested,
                Math.floor((rules.deckSize - seats * rules.holeCardsDealt) / 5)
              );
              expect(controller.getActiveBoardCount()).toBe(actual);
              const state = {
                ...jointPolicyFixture(variant, 1, mode).state,
                ...controller.getChipRulesSnapshot(),
                players: live.players.map((p) => ({ ...p, cards: [], knownDeadCards: undefined })),
                dealtSeatIds: live.players.map((p) => p.seat),
                communityCards: live.communityCards,
                communityCards2: live.communityCards2,
                communityCards3: live.communityCards3,
                boardCount: actual,
                bombPot: true,
                stage: live.stage,
                heroSeat: hero.seat,
                currentPlayerSeat: hero.seat,
                dealerSeat: seats,
                pot: live.pot,
                currentBet: live.currentBet,
                minRaise: live.minRaise,
                toCall: menu.toCall,
                legalActions: menu.legalActions,
                minRaiseTo: menu.minRaiseTo,
                maxRaiseTo: menu.maxRaiseTo,
                fixedBetSize: menu.fixedBetSize,
                wagersCapped: menu.wagersCapped,
                pots: controller.computeLivePots(),
                actionHistory: live.actionHistory,
              };
              const privateHero = {
                ...hero,
                knownDeadCards: controller.getPineappleKnownDeadCards(hero.seat),
              };
              const result = evaluateJointLivePolicy(
                privateHero,
                state,
                { action: 'check', thinkTime: 0 },
                'shadow',
                () => 0
              );
              expect(
                result.receipt.fired,
                JSON.stringify({ mode, requested, actual, trigger, reason: result.receipt.reason })
              ).toBe(true);
              expect(result.receipt.boardCount).toBe(actual);
              expect(result.receipt.dealtPlayers).toBe(seats);
              expect(result.receipt.ranges).toHaveLength(seats - 1);
            } finally {
              controller.cancelPineappleSettle();
            }
          }
      }
    }
  );
  it('keeps unavailable Spin variants outside the policy domain', () => {
    for (const variant of ['short_deck', 'flh', 'flo8', 'plo8'] as GameVariant[]) {
      const s = jointPolicyFixture(variant, 2, 'tournament');
      s.state.format = 'spin';
      expect(
        evaluateJointLivePolicy(s.hero, s.state, s.baseline, 'candidate', () => 0).receipt.reason
      ).toBe('variant_spin_unavailable');
    }
  });
});
