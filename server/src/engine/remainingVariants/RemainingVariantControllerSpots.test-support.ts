/**
 * P12.1 test support: natural Short Deck, Crazy Pineapple, FLH and FLO8
 * decision states produced by a real HandController.
 *
 * Every state is the one the engine itself reached: blinds posted from the
 * controller's own seats, the controller's authoritative menu (legal actions,
 * min/max raise-to, fixed bet, cap), real Pineapple discards accepted by
 * `performDiscard`, and the public seat list stripped of private cards exactly
 * as the live state builder strips it. Driving actions are drawn from the
 * controller's own menu with a seeded local generator, so short stacks,
 * all-ins, short fixed-limit openings and their completions arise naturally.
 */
import type { HandConfig, HorseDecision, SeatPlayer } from '../../types.js';
import type { HorseGameStateV2 } from '../HorseLogic.js';
import { HandController } from '../HandController.js';
import { calculateContestablePot } from '../PokerEngine.js';
import { horseVariantRulesFor } from '../VariantRules.js';
import {
  remainingVariantSeatCap,
  type RemainingPolicyVariant,
} from './RemainingVariantPolicyPack.js';

export interface ControllerSpot {
  variant: RemainingPolicyVariant;
  mode: 'cash' | 'tournament';
  hero: SeatPlayer;
  state: HorseGameStateV2;
  baseline: HorseDecision;
  controller: HandController;
}

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

/** A seeded xorshift stream, independent of the brain's own generator. */
export function controllerSpotRandom(seed: number) {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 0x100000000;
  };
}

/** The decision state the live builder would hand the brain right now. */
export function controllerDecisionState(
  controller: HandController,
  variant: RemainingPolicyVariant,
  mode: 'cash' | 'tournament',
  config: HandConfig
): ControllerSpot | null {
  const state = controller.getState();
  const actor = state.players.find((p) => p.seat === state.currentPlayerSeat);
  if (!actor || state.stage === 'pineapple_discard' || state.stage === 'showdown') return null;
  const menu = controller.getAuthoritativeActionState(actor.user_id);
  if (!menu?.canAct) return null;
  const s: HorseGameStateV2 = {
    stateSchemaVersion: 1,
    dealtSeatIds: state.players
      .filter((p) => p.cards.length > 0)
      .map((p) => p.seat)
      .sort((a, b) => a - b),
    blindSeats: controller.getBlindSeatsSnapshot?.() ?? null,
    ...controller.getChipRulesSnapshot(),
    heroSeat: actor.seat,
    currentPlayerSeat: actor.seat,
    legalActions: [...menu.legalActions],
    toCall: menu.toCall,
    minRaiseTo: menu.minRaiseTo,
    maxRaiseTo: menu.maxRaiseTo,
    bettingStructure: menu.structure,
    fixedBetSize: menu.fixedBetSize,
    fixedLimitSmallBet: controller.getFixedLimitSmallBet?.() ?? null,
    wagersCapped: menu.wagersCapped,
    pots: controller.computeLivePots(),
    contestablePot: calculateContestablePot(state.players, actor.user_id, menu.toCall),
    rakeConfig: controller.getRakeConfigSnapshot(),
    variantRules: horseVariantRulesFor(variant),
    players: state.players.map((p) => {
      const { knownDeadCards: _private, ...rest } = p;
      return { ...rest, cards: [] };
    }),
    communityCards: [...state.communityCards],
    communityCards2: [],
    communityCards3: [],
    bombPot: false,
    boardCount: 1,
    pot: state.pot,
    currentBet: state.currentBet,
    minRaise: state.minRaise,
    lastRaise: state.lastRaise,
    stage: state.stage,
    gameVariant: variant,
    bigBlind: config.bigBlind,
    dealerSeat: state.dealerSeat,
    actionHistory: state.actionHistory.map((a) => ({ ...a })),
    gameMode: mode,
    format: mode === 'cash' ? 'cash' : 'mtt',
    ante: config.ante ?? 0,
    straddleActive: false,
  } as HorseGameStateV2;
  const hero: SeatPlayer = {
    ...actor,
    cards: actor.cards.map((c) => ({ ...c })),
    knownDeadCards:
      variant === 'pineapple' ? controller.getPineappleKnownDeadCards(actor.seat) : [],
  };
  const baseline: HorseDecision = {
    action: menu.toCall > 0 ? 'call' : 'check',
    ...(menu.toCall > 0
      ? { amount: Math.round(Math.min(menu.toCall, actor.stack) * 100) / 100 }
      : {}),
    thinkTime: 0,
  };
  return { variant, mode, hero, state: s, baseline, controller };
}

/**
 * Plays `hands` real hands per call and hands every decision point to
 * `visit`. Seat counts run from heads-up to the pack's ceiling for the mode.
 */
export function forEachControllerSpot(
  variant: RemainingPolicyVariant,
  mode: 'cash' | 'tournament',
  hands: number,
  seed: number,
  visit: (spot: ControllerSpot) => void
) {
  const random = controllerSpotRandom(seed);
  const cap = remainingVariantSeatCap(variant, mode);
  for (let hand = 0; hand < hands; hand++) {
    const seats = 2 + Math.floor(random() * (cap - 1));
    const stakes = STAKES[mode][Math.floor(random() * STAKES[mode].length)];
    const [smallBlind, bigBlind] = stakes;
    const chip = (n: number) =>
      mode === 'tournament'
        ? Math.max(1, Math.round(n))
        : Math.max(0.01, Math.round(n * 100) / 100);
    const players: SeatPlayer[] = Array.from({ length: seats }, (_, i) => {
      // Stacks from under one big blind to 300 big blinds, so short all-ins,
      // near-stack wagers and deep stacks all occur.
      const depth = random() < 0.25 ? 0.6 + random() * 12 : 2 + random() * 298;
      return {
        seat: i + 1,
        user_id: `p12-1-${variant}-${i + 1}`,
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
    const ante =
      mode === 'tournament' && random() < 0.4 ? chip(bigBlind * (random() < 0.5 ? 0.1 : 0.5)) : 0;
    const config: HandConfig = {
      tableId: `p12-1-${variant}-${mode}`,
      handNumber: hand + 1,
      gameVariant: variant,
      smallBlind,
      bigBlind,
      ante,
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
      const spot = controllerDecisionState(controller, variant, mode, config);
      if (!spot) break;
      visit(spot);
      // Drive the hand on from the controller's own menu.
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
      } else if (roll < 0.36 && legal.includes('all_in')) {
        done = controller.performAction(spot.hero.seat, 'all_in');
      } else if (roll < 0.44 && legal.includes('fold') && menu.toCall > 0) {
        done = controller.performAction(spot.hero.seat, 'fold');
      }
      if (!done)
        done = controller.performAction(spot.hero.seat, legal.includes('check') ? 'check' : 'call');
      if (!done) break;
    }
  }
}
