import { afterEach, describe, expect, it } from 'vitest';
import { HorseLogic, hasStrongPressureDraw, type HorseDecideOpts } from './HorseLogic.js';
import { HorseMind, readScopeOf } from './HorseMind.js';
import { freshExploitCounters } from './HorseOpponentExploit.js';
import { seedFastRandom, saveFastRandom } from './HorseEval.js';
import { enableBrainTelemetry, drainFires } from './BrainTelemetry.js';
import type { Card, SeatPlayer, HandConfig } from '../types.js';
import { HandController } from './HandController.js';
import { Deck } from './PokerEngine.js';
import { controllerDecisionState } from './remainingVariants/RemainingVariantControllerSpots.test-support.js';
import type { RemainingPolicyVariant } from './remainingVariants/RemainingVariantPolicyPack.js';
const c = (rank: string, suit: string) => ({ rank, suit }) as Card;
const board = [c('8', 'diamonds'), c('T', 'diamonds'), c('2', 'clubs')];
const plo = [c('A', 'diamonds'), c('K', 'diamonds'), c('J', 'hearts'), c('9', 'hearts')];
const nlh = [c('A', 'spades'), c('5', 'spades')];
const nlhBoard = [c('7', 'spades'), c('4', 'spades'), c('2', 'diamonds')];
afterEach(() => {
  HorseMind.reset();
  drainFires();
});
describe('Physical combo draws own their pressure domain', () => {
  it.each(['plo4', 'plo5', 'plo6'] as const)(
    '%s recognizes the actual nut flush draw with straight backup',
    (v) => {
      const hole = [
        ...plo,
        ...(v === 'plo4' ? [] : [c('3', 'clubs')]),
        ...(v === 'plo6' ? [c('4', 'hearts')] : []),
      ];
      expect(hasStrongPressureDraw(hole, board, v)).toBe(true);
    }
  );
  it('NLH recognizes the nut flush plus straight draw', () =>
    expect(hasStrongPressureDraw(nlh, nlhBoard, 'nlh')).toBe(true));
  it('refuses a naked dominated flush draw, a paired board, river and hi-lo', () => {
    expect(
      hasStrongPressureDraw(
        [c('Q', 'diamonds'), c('4', 'diamonds'), c('6', 'hearts'), c('3', 'spades')],
        board,
        'plo4'
      )
    ).toBe(false);
    expect(hasStrongPressureDraw(plo, [board[0], c('8', 'clubs'), board[1]], 'plo4')).toBe(false);
    expect(hasStrongPressureDraw(plo, [...board, c('5', 'clubs'), c('6', 'spades')], 'plo4')).toBe(
      false
    );
    expect(hasStrongPressureDraw(plo, board, 'plo8')).toBe(false);
  });
});
function spot(variant: string, scale = 1) {
  const hole =
    variant === 'nlh'
      ? nlh
      : [
          ...plo,
          ...(variant === 'plo4' ? [] : [c('3', 'clubs')]),
          ...(variant === 'plo6' ? [c('4', 'hearts')] : []),
        ];
  const flop = variant === 'nlh' ? nlhBoard : board;
  const key = (c: Card) => c.rank + ':' + c.suit;
  const known = new Set([...hole, ...flop].map(key));
  const shuffle = Deck.prototype.shuffle;
  Deck.prototype.shuffle = function fixedDeck(this: Deck) {
    const d = this as unknown as { cards: Card[] };
    const spare = d.cards.filter((c) => !known.has(key(c)));
    d.cards = [...hole, ...spare.slice(0, hole.length), ...flop, ...spare.slice(hole.length)];
  };
  let controller: HandController;
  let complete: { rake?: number; bbjFee?: number } | null = null;
  const hero = {
    seat: 1,
    user_id: 'hero',
    username: 'hero',
    stack: 75 * scale,
    bet: 0,
    totalInvested: 0,
    cards: [],
    is_folded: false,
    is_all_in: false,
    is_sitting_out: false,
    is_horse: true,
  } as SeatPlayer;
  const opponent = {
    ...hero,
    seat: 2,
    user_id: 'wide',
    username: 'wide',
    stack: 95 * scale,
    is_horse: false,
  } as SeatPlayer;
  const config = {
    tableId: '40000000-0000-4000-8000-0000000000ab',
    handNumber: 1,
    gameVariant: variant,
    smallBlind: scale,
    bigBlind: 2 * scale,
    ante: 0,
    isTournament: false,
    rakeConfig: { percent: 5, cap: 6 * scale, noFlopNoDrop: true },
  } as HandConfig;
  try {
    controller = new HandController(config, [hero, opponent], 1);
    controller.onEvent((e) => {
      if (e.type === 'HAND_COMPLETE') complete = e as unknown as { rake?: number; bbjFee?: number };
    });
    controller.start();
  } finally {
    Deck.prototype.shuffle = shuffle;
  }
  // Real legal preflop pot construction: six, fifteen, call nine => thirty.
  expect(controller.performAction(1, 'raise', 6 * scale)).toBe(true);
  expect(controller.performAction(2, 'raise', 15 * scale)).toBe(true);
  expect(controller.performAction(1, 'call')).toBe(true);
  expect(controller.performAction(2, 'bet', 20 * scale)).toBe(true);
  const captured = controllerDecisionState(
    controller,
    variant as RemainingPolicyVariant,
    'cash',
    config
  );
  expect(captured).not.toBeNull();
  expect(captured!.hero.user_id).toBe('hero');
  expect(captured!.state.pot).toBeCloseTo(50 * scale, 8);
  expect(captured!.hero.stack).toBeCloseTo(60 * scale, 8);
  return { hero: captured!.hero, gs: captured!.state, controller, getComplete: () => complete };
}
function decide(variant: string, seed: number, enabled: boolean, scale = 1, read = true) {
  const sandbox = HorseMind.createSandbox(),
    scope = readScopeOf(variant, 2);
  sandbox.exploit.set(scope + '|wide', {
    ...freshExploitCounters(),
    hands: 100,
    vpip: 90,
    pfr: 80,
    rfiOpp: 80,
    rfi: 70,
    threeBetOpp: 60,
    threeBet: 40,
    betCheckedToOpp: 100,
    betCheckedTo: 80,
    foldToBetOpp: 100,
    foldToBet: 55,
    fHands: 20,
    fPfr: 16,
    fRfiOpp: 16,
    fRfi: 14,
    fThreeBetOpp: 12,
    fThreeBet: 8,
    fBetCheckedToOpp: 20,
    fBetCheckedTo: 16,
    fFoldToBetOpp: 20,
    fFoldToBet: 11,
  });
  if (!read) sandbox.exploit.clear();
  const { hero, gs, controller, getComplete } = spot(variant, scale);
  seedFastRandom(seed);
  const decision = HorseMind.runInSandbox(sandbox, () =>
    HorseLogic.decide(hero, gs, 'balanced', {}, {
      observeMind: false,
      decisionTimeMs: 1793000000000,
      telemetry: true,
      comboDrawPressure: enabled,
    } as HorseDecideOpts)
  );
  if (['raise', 'all_in'].includes(decision.action)) {
    expect(controller.performAction(hero.seat, decision.action, decision.amount)).toBe(true);
    // Complete that actual hand through ordinary calls/checks and runout;
    // accepted pressure must conserve chips, including the real rake.
    for (let step = 0; step < 40 && !getComplete(); step++) {
      const state = controller.getState(),
        actor = state.players.find((p) => p.seat === state.currentPlayerSeat);
      const menu = actor ? controller.getAuthoritativeActionState(actor.user_id) : null;
      if (actor && menu?.canAct)
        expect(
          controller.performAction(
            actor.seat,
            menu.legalActions.includes('check') ? 'check' : 'call'
          )
        ).toBe(true);
      else controller.continueRunout();
    }
    const done = getComplete();
    expect(done).not.toBeNull();
    expect(
      controller.getState().players.reduce((sum, p) => sum + p.stack, 0) +
        (done?.rake ?? 0) +
        (done?.bbjFee ?? 0)
    ).toBeCloseTo(170 * scale, 6);
  }
  return decision;
}
describe('The actual brain evaluates combo-draw re-pot instead of only calling', () => {
  it.each(['nlh', 'plo4', 'plo5', 'plo6'])(
    '%s produces a new legal pressure action from a former flat',
    (v) => {
      enableBrainTelemetry();
      drainFires();
      let contrasts = 0;
      for (let seed = 31; seed < 63; seed++) {
        const off = decide(v, seed, false),
          on = decide(v, seed, true);
        if (off.action === 'call' && ['raise', 'all_in'].includes(on.action)) contrasts++;
        if (on.action === 'raise') {
          expect(on.amount).toBeGreaterThanOrEqual(40);
          expect(on.amount).toBeLessThanOrEqual(60);
        }
      }
      const fires = drainFires();
      expect(fires.some((x) => x.feature === 'combo_draw_pressure_raise' && x.fires > 0)).toBe(
        true
      );
      expect(contrasts).toBeGreaterThan(0);
    },
    30000
  );
});

// Diagnostic wall times vary even for the same decision; preserve all
// behavior/authority fields and the exact post-decision RNG state.
const signature = (decision: unknown) =>
  JSON.stringify({ decision, rng: saveFastRandom() }, (key, value) =>
    ['elapsedMs', 'latencyMs', 'policyMs', 'simulationMs', 'analysisMs'].includes(key)
      ? undefined
      : value
  );
describe('Pressure remains legal across stakes and refuses unknown reads', () => {
  it.each(['nlh', 'plo4', 'plo5', 'plo6'])(
    '%s retains the original decision without an aggressive public read',
    (v) => {
      enableBrainTelemetry();
      drainFires();
      for (let seed = 31; seed < 39; seed++)
        expect(signature(decide(v, seed, true, 1, false))).toBe(
          signature(decide(v, seed, false, 1, false))
        );
      expect(drainFires().some((x) => x.feature === 'combo_draw_pressure_evaluated')).toBe(false);
    }
  );
  it.each(['nlh', 'plo4', 'plo5', 'plo6'])(
    '%s accepts pressure and conserves money at fractional and larger stakes',
    (v) => {
      for (const scale of [0.01, 10]) {
        enableBrainTelemetry();
        drainFires();
        for (let seed = 31; seed < 47; seed++) decide(v, seed, true, scale);
        expect(
          drainFires().some((x) => x.feature === 'combo_draw_pressure_raise' && x.fires > 0)
        ).toBe(true);
      }
    },
    30000
  );
});
