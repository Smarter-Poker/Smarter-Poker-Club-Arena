import { afterEach, describe, expect, it } from 'vitest';
import fixture from './fixtures/horse-plo5-trip-board-45872846.json';
import { HorseLogic, type HorseGameStateV2 } from './HorseLogic.js';
import { enableBrainTelemetry, drainFires } from './BrainTelemetry.js';
import { HorseMind } from './HorseMind.js';
import { seedFastRandom, omahaBoatsAbove } from './HorseEval.js';
import { calculateContestablePot, calculatePots } from './PokerEngine.js';
import { horseVariantRulesFor } from './VariantRules.js';
import type { HorsePublicActionNode } from './HorsePublicActionNode.js';
import type { ActionRecord, Card, HorseStyle, SeatPlayer } from '../types.js';

type Variant = 'plo4' | 'plo5' | 'plo6' | 'plo8';
type Captured = Extract<HorsePublicActionNode, { status: 'captured' }>;
const actions = fixture.actions as unknown as Array<ActionRecord & { publicNode?: Captured }>;
const holdings = fixture.heroCards as Record<string, Card[]>;
const styles: HorseStyle[] = ['tag', 'lag', 'balanced', 'tricky', 'grinder'];
const variants: Variant[] = ['plo4', 'plo5', 'plo6', 'plo8'];
const bySeat = new Map(actions.map((action) => [action.seat, action.userId]));

/** Accepted public controller nodes and this actor's revealed cards only.
 * The other seats retain empty cards, including the opponent. Historical read frames
 * and the original RNG are unavailable: this is a scoped decision regression,
 * not a claim to replay the original worker's exact learned state. */
function incident(ordinal: number, variant: Variant = 'plo5') {
  const action = actions[ordinal];
  const n = action.publicNode;
  if (!n || n.status !== 'captured' || n.deductions?.status !== 'captured')
    throw Error('accepted public decision node missing');
  const players: SeatPlayer[] = n.seats.map(
    ([seat, stack, bet, totalInvested, deadInvested, individualAnteInvested, flags]) =>
      ({
        seat,
        user_id: bySeat.get(seat)!,
        username: `Seat ${seat}`,
        stack,
        bet,
        totalInvested,
        deadInvested,
        individualAnteInvested,
        is_folded: !!(flags & 1),
        is_all_in: !!(flags & 2),
        is_sitting_out: !!(flags & 4),
        cards: [],
      }) as SeatPlayer
  );
  const ownCards = holdings[action.userId].map((card) => ({ ...card }));
  // The extra card removed/added is unrelated to the pocket pair or public board.
  if (variant === 'plo4' || variant === 'plo8') ownCards.splice(4, 1);
  if (variant === 'plo6') ownCards.push({ rank: '6', suit: 'clubs' });
  const hero: SeatPlayer = {
    ...players.find((player) => player.seat === action.seat)!,
    cards: ownCards,
  };
  const communityCards = fixture.communityCards
    .slice(0, n.street === 'flop' ? 3 : n.street === 'turn' ? 4 : 5)
    .map((card) => ({ rank: card[0], suit: card.slice(1) }) as Card);
  const state: HorseGameStateV2 = {
    stateSchemaVersion: 1,
    dealtSeatIds: players.map((player) => player.seat),
    blindSeats: { smallBlind: 3, bigBlind: 4 },
    chipUnit: n.chipUnit,
    asset: n.asset,
    heroSeat: hero.seat,
    currentPlayerSeat: hero.seat,
    legalActions: [...n.legalActions],
    toCall: n.toCall,
    minRaiseTo: n.minRaiseTo,
    maxRaiseTo: n.maxRaiseTo,
    bettingStructure: n.structure,
    fixedBetSize: n.fixedBetSize,
    wagersCapped: n.wagersCapped,
    pots: calculatePots(players),
    contestablePot: calculateContestablePot(players, hero.user_id, n.toCall),
    rakeConfig: {
      ...n.deductions.rake,
      playerCountCaps: n.deductions.rake.playerCountCaps.map(([players, cap]) => ({
        players,
        cap,
      })),
    },
    bbjConfig: n.deductions.bbj,
    variantRules: horseVariantRulesFor(variant),
    players,
    communityCards,
    communityCards2: [],
    communityCards3: [],
    bombPot: false,
    boardCount: 1,
    pot: n.pot,
    currentBet: n.currentBet,
    minRaise: ordinal === 22 ? 109 : n.bigBlind,
    lastRaise: ordinal === 22 ? 109 : n.bigBlind,
    stage: n.street,
    gameVariant: variant,
    bigBlind: n.bigBlind,
    dealerSeat: n.dealerSeat,
    actionHistory: actions.slice(0, ordinal),
    gameMode: n.mode,
    format: 'cash',
    ante: n.ante,
    straddleActive: false,
  };
  return { hero, state };
}

type Control = 'jj' | 'aa' | 'top' | 'quads';
type Boundary = 'first' | 'raised' | 'allinprice';
function configured(variant: Variant, control: Control = 'jj', boundary: Boundary = 'first') {
  const spot = incident(22, variant);
  const { hero, state } = spot;
  if (control !== 'jj')
    hero.cards[0] = {
      rank: control === 'top' ? 'T' : control === 'quads' ? '2' : 'A',
      suit: 'clubs',
    };
  if (boundary === 'raised') {
    hero.bet = 2;
    hero.stack -= 2;
    hero.totalInvested += 2;
    const seated = state.players.find((player) => player.seat === hero.seat)!;
    Object.assign(seated, { bet: hero.bet, stack: hero.stack, totalInvested: hero.totalInvested });
    state.toCall = 107;
    state.pot = 256;
    state.actionHistory = state.actionHistory!.map((action, ordinal) =>
      ordinal === 20
        ? { ...action, action: 'bet', amount: 2 }
        : ordinal === 21
          ? { ...action, action: 'raise' }
          : action
    );
  }
  if (boundary === 'allinprice') {
    const opponent = state.players.find((player) => player.seat === 2)!;
    opponent.stack -= hero.stack - opponent.bet;
    opponent.totalInvested += hero.stack - opponent.bet;
    opponent.bet = hero.stack;
    state.toCall = hero.stack;
    state.currentBet = hero.stack;
    state.maxRaiseTo = null;
    state.minRaiseTo = null;
    state.legalActions = ['fold', 'call', 'all_in'];
    state.pot = 145 + hero.stack;
    state.actionHistory = state.actionHistory!.map((action, ordinal) =>
      ordinal === 21 ? { ...action, amount: hero.stack } : action
    );
  }
  state.pots = calculatePots(state.players);
  state.contestablePot = calculateContestablePot(state.players, hero.user_id, state.toCall!);
  return spot;
}
function decide(spot: ReturnType<typeof incident>, style: HorseStyle, seed = 100) {
  HorseMind.reset();
  seedFastRandom(seed);
  return HorseLogic.decide(spot.hero, spot.state, style, {}, { telemetry: false });
}
function features(spot: ReturnType<typeof incident>): string[] {
  HorseMind.reset();
  seedFastRandom(100);
  enableBrainTelemetry();
  drainFires();
  HorseLogic.decide(spot.hero, spot.state, 'balanced', {}, { telemetry: true });
  return drainFires().map((row) => row.feature);
}
afterEach(() => {
  HorseMind.reset();
  drainFires();
});

describe('PLO trip-board full house incident 45872846', () => {
  it('retains the exact first-bet price and only acting private cards', () => {
    const { hero, state } = configured('plo5');
    expect(hero.stack).toBe(295.9);
    expect(state).toMatchObject({ toCall: 109, pot: 254, minRaiseTo: 218, maxRaiseTo: 295.9 });
    expect(state.players.every((player) => player.cards.length === 0)).toBe(true);
    expect(omahaBoatsAbove(hero.cards, state.communityCards)).toEqual({ boats: 5, quads: 12 });
  });
  it('recognizes AA is also under-full; TT is the true top boat', () => {
    const aces = configured('plo5', 'aa');
    const tens = configured('plo5', 'top');
    expect(omahaBoatsAbove(aces.hero.cards, aces.state.communityCards).boats).toBe(2);
    expect(omahaBoatsAbove(tens.hero.cards, tens.state.communityCards).boats).toBe(0);
  });
  // PLO6 is ruled separately since 2026-10-25 (Dan: "IN PLO6 IF ITS NOT THE
  // NUTS, ITS PROBABLY NOT GOOD"; V58, HorsePlo6RiverNuts.test.ts): on this
  // river the under-full (beaten by a random six-card hand ~40% of the time)
  // folds to the bet, the top boat (~15%, only the last deuce) calls without
  // raising, and quads keeps its value raise. PLO4, PLO5 and PLO8 keep the
  // original incident ruling below unchanged.
  for (const style of styles) {
    it(`plo6/${style} folds the under-full and flats the top boat (V58)`, () => {
      for (let seed = 100; seed < 112; seed++)
        expect(decide(configured('plo6'), style, seed).action).toBe('fold');
      expect(decide(configured('plo6', 'jj', 'raised'), style).action).toBe('fold');
      expect(decide(configured('plo6', 'jj', 'allinprice'), style).action).toBe('fold');
      expect(['call', 'all_in']).toContain(decide(configured('plo6', 'top'), style).action);
      expect(['raise', 'all_in']).toContain(decide(configured('plo6', 'quads'), style).action);
    });
  }
  for (const variant of variants.filter((v) => v !== 'plo6'))
    for (const style of styles) {
      it(`${variant}/${style} flats a first bet or later raise without adding the extra 186.90`, () => {
        for (let seed = 100; seed < 112; seed++) {
          expect(decide(configured(variant), style, seed)).toMatchObject({
            action: 'call',
            amount: 109,
          });
        }
        expect(decide(configured(variant, 'jj', 'raised'), style)).toMatchObject({
          action: 'call',
          amount: 107,
        });
      });
      it(`${variant}/${style} preserves true top-boat and literal-quads value`, () => {
        expect(['raise', 'all_in']).toContain(decide(configured(variant, 'top'), style).action);
        expect(['raise', 'all_in']).toContain(decide(configured(variant, 'quads'), style).action);
      });
      it(`${variant}/${style} calls an affordable terminal price without an over-raise`, () => {
        const spot = configured(variant, 'jj', 'allinprice');
        const action = decide(spot, style);
        expect(['call', 'all_in']).toContain(action.action);
        if (action.action === 'call') expect(action.amount).toBe(spot.hero.stack);
      });
    }
  it('records the relative-boat flat, but does not apply it to checked-to or turn nodes', () => {
    const key = 'horse_continuation_trip_board_boat_flat';
    expect(features(configured('plo5'))).toContain(key);
    expect(features(incident(20))).not.toContain(key);
    expect(features(incident(18))).not.toContain(key);
  });
});
