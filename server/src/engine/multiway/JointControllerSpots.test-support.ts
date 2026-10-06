/**
 * P13.1 test support: natural multiway decision states for every Phase 13
 * variant, produced by a real HandController.
 *
 * The P12.1 controller spots (RemainingVariantControllerSpots.test-support.ts)
 * generalised to the nine joint variants: blinds posted from the controller's
 * own seats, the controller's authoritative menu (legal actions, min/max
 * raise-to, pot-limit cap, fixed bet), real Pineapple discards, and the public
 * seat list stripped of private cards exactly as the live builder strips it.
 * Every hand deals three or more seats, so the joint owner (and not the
 * heads-up variant owner) is the one asked.
 */
import type { GameVariant, HandConfig, SeatPlayer } from '../../types.js';
import { HandController } from '../HandController.js';
import { maxSeatsForVariant } from '../../config/tableSeating.js';
import { maxSeatsFor } from '../VariantRules.js';
import {
  controllerDecisionState,
  controllerSpotRandom,
  type ControllerSpot,
} from '../remainingVariants/RemainingVariantControllerSpots.test-support.js';

export const JOINT_SPOT_VARIANTS: readonly GameVariant[] = [
  'nlh',
  'plo4',
  'plo5',
  'plo6',
  'plo8',
  'flo8',
  'flh',
  'pineapple',
  'short_deck',
];

const STAKES = {
  cash: [
    [1, 2],
    [5, 10],
    [25, 50],
    [0.05, 0.1],
  ],
  tournament: [
    [10, 20],
    [50, 100],
    [300, 600],
  ],
} as const;

export type JointControllerSpot = Omit<ControllerSpot, 'variant'> & { variant: GameVariant };

/** Plays `hands` real hands and hands every decision point to `visit`. */
export function forEachJointControllerSpot(
  variant: GameVariant,
  mode: 'cash' | 'tournament',
  hands: number,
  seed: number,
  visit: (spot: JointControllerSpot) => void
) {
  const random = controllerSpotRandom(seed);
  const cap = Math.min(
    mode === 'cash' ? maxSeatsForVariant(variant) : Math.min(10, maxSeatsFor(variant)),
    7
  );
  for (let hand = 0; hand < hands; hand++) {
    const seats = 3 + Math.floor(random() * (cap - 2));
    const stakes = STAKES[mode][Math.floor(random() * STAKES[mode].length)];
    const [smallBlind, bigBlind] = stakes;
    const chip = (n: number) =>
      mode === 'tournament'
        ? Math.max(1, Math.round(n))
        : Math.max(0.01, Math.round(n * 100) / 100);
    const players: SeatPlayer[] = Array.from({ length: seats }, (_, i) => {
      // Under one big blind to 200 big blinds: short all-ins, near-stack
      // wagers and deep stacks all occur, inside the joint depth domain.
      const depth = random() < 0.25 ? 0.6 + random() * 12 : 2 + random() * 198;
      return {
        seat: i + 1,
        user_id: `p13-1-${variant}-${i + 1}`,
        username: `Horse ${i + 1}`,
        stack: chip(depth * bigBlind),
        bet: 0,
        totalInvested: 0,
        cards: [],
        is_folded: false,
        is_all_in: false,
        is_sitting_out: false,
        is_horse: true,
      };
    });
    const config: HandConfig = {
      tableId: `p13-1-${variant}-${mode}`,
      handNumber: hand + 1,
      gameVariant: variant,
      smallBlind,
      bigBlind,
      ante: 0,
      isTournament: mode === 'tournament',
      rakeConfig:
        mode === 'cash'
          ? {
              percent: [0, 2.5, 5, 10][Math.floor(random() * 4)],
              cap: 3 * bigBlind,
              noFlopNoDrop: true,
            }
          : { percent: 0, cap: 0, noFlopNoDrop: true },
    };
    const controller = new HandController(config, players, 1 + Math.floor(random() * seats));
    controller.start();
    for (let step = 0; step < 120; step++) {
      const live = controller.getState();
      if (live.stage === 'pineapple_discard') {
        for (const p of live.players.filter((x) => !x.is_folded && x.cards.length === 3))
          if (!controller.performDiscard(p.seat, Math.floor(random() * 3))) return;
        controller.flushPineappleSettle();
        continue;
      }
      const spot = controllerDecisionState(controller, variant as never, mode, config);
      if (!spot) break;
      visit({ ...spot, variant });
      const menu = controller.getAuthoritativeActionState(spot.hero.user_id)!;
      const legal = menu.legalActions;
      const roll = random();
      let done = false;
      if (
        roll < 0.3 &&
        (legal.includes('raise') || legal.includes('bet')) &&
        menu.minRaiseTo !== null &&
        menu.maxRaiseTo !== null
      ) {
        const to = chip(menu.minRaiseTo + random() * (menu.maxRaiseTo - menu.minRaiseTo));
        const amount = Math.min(menu.maxRaiseTo, Math.max(menu.minRaiseTo, to));
        done = controller.performAction(
          spot.hero.seat,
          legal.includes('raise') ? 'raise' : 'bet',
          amount
        );
      } else if (roll < 0.34 && legal.includes('all_in')) {
        done = controller.performAction(spot.hero.seat, 'all_in');
      } else if (roll < 0.4 && legal.includes('fold') && menu.toCall > 0) {
        done = controller.performAction(spot.hero.seat, 'fold');
      }
      if (!done)
        done = controller.performAction(spot.hero.seat, legal.includes('check') ? 'check' : 'call');
      if (!done) break;
    }
  }
}
