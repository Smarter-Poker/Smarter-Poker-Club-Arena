import { afterEach, expect, it } from 'vitest';
import assert from 'node:assert/strict';
import type { Card, SeatPlayer } from '../types.js';
import { HandController } from './HandController.js';
import { Deck, calculateContestablePot } from './PokerEngine.js';
import { HorseLogic, type HorseGameStateV2 } from './HorseLogic.js';
import { HorseMind } from './HorseMind.js';
import { seedFastRandom, scoreOmahaHi, scoreOmahaLow } from './HorseEval.js';
import { headsUpCashCommitment } from './HorseHeadsUpCommitment.js';
import { horsePlanHandKey } from './HorseDecisionEffects.js';
import { horseVariantRulesFor } from './VariantRules.js';

const suits = { c: 'clubs', d: 'diamonds', h: 'hearts', s: 'spades' } as const;
const cards = (text: string): Card[] =>
  text
    .split(' ')
    .map((c) => ({ rank: c[0] as Card['rank'], suit: suits[c[1] as keyof typeof suits] }));
const heroId = '10000000-0000-4000-8000-000000000001';
const villainId = '10000000-0000-4000-8000-000000000002';
const board = 'Kc 7c 6h 3c 2d';
function spot(
  initial: number,
  own = 'Ac Qc Jh Td',
  publicBoard = board,
  opponent = 'As 4h 5s 9d',
  opponentInitial = 100
) {
  const prefix = [...cards(own), ...cards(opponent), ...cards(publicBoard)];
  assert.equal(new Set(prefix.map((c) => c.rank + c.suit)).size, prefix.length);
  const original = Deck.prototype.shuffle;
  Deck.prototype.shuffle = function () {
    const deck = (this as unknown as { cards: Card[] }).cards;
    const rest = deck.filter((c) => !prefix.some((p) => p.rank === c.rank && p.suit === c.suit));
    deck.splice(0, deck.length, ...prefix, ...rest);
  };
  const players: SeatPlayer[] = [1, 2].map((seat) => ({
    seat,
    user_id: seat === 1 ? heroId : villainId,
    username: `Player${seat}`,
    stack: seat === 1 ? initial : opponentInitial,
    bet: 0,
    totalInvested: 0,
    cards: [],
    is_folded: false,
    is_all_in: false,
    is_sitting_out: false,
  }));
  const controller = new HandController(
    {
      tableId: '20000000-0000-4000-8000-000000000001',
      handNumber: 1000001,
      gameVariant: 'plo8',
      smallBlind: 1,
      bigBlind: 2,
      ante: 0,
      rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
    },
    players,
    1
  );
  try {
    controller.start();
  } finally {
    Deck.prototype.shuffle = original;
  }
  for (const [seat, action, amount] of [
    [1, 'raise', 6],
    [2, 'raise', 18],
    [1, 'call', undefined],
    [2, 'check', undefined],
    [1, 'check', undefined],
    [2, 'check', undefined],
    [1, 'check', undefined],
    [2, 'bet', 36],
  ] as const)
    assert(controller.performAction(seat, action, amount, 'player'));
  const state = controller.getState();
  const actor = controller.getCurrentPlayer()!;
  assert.equal(actor.user_id, heroId);
  const menu = controller.getAuthoritativeActionState(heroId)!;
  const hero = { ...actor, cards: actor.cards.map((c) => ({ ...c })), knownDeadCards: [] };
  const gs: HorseGameStateV2 = {
    stateSchemaVersion: 1,
    dealtSeatIds: state.players.map((p) => p.seat),
    blindSeats: controller.getBlindSeatsSnapshot(),
    ...controller.getChipRulesSnapshot(),
    heroSeat: actor.seat,
    currentPlayerSeat: actor.seat,
    legalActions: [...menu.legalActions],
    toCall: menu.toCall,
    minRaiseTo: menu.minRaiseTo,
    maxRaiseTo: menu.maxRaiseTo,
    bettingStructure: menu.structure,
    fixedBetSize: menu.fixedBetSize,
    fixedLimitSmallBet: controller.getFixedLimitSmallBet(),
    wagersCapped: menu.wagersCapped,
    pots: controller.computeLivePots(),
    contestablePot: calculateContestablePot(state.players, heroId, menu.toCall),
    rakeConfig: controller.getRakeConfigSnapshot(),
    variantRules: horseVariantRulesFor('plo8'),
    players: state.players.map((p) => {
      const { knownDeadCards, ...publicPlayer } = p;
      return { ...publicPlayer, cards: [] };
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
    gameVariant: 'plo8',
    smallBlind: 1,
    bigBlind: 2,
    dealerSeat: state.dealerSeat,
    actionHistory: state.actionHistory.map((a) => ({ ...a })),
    gameMode: 'cash',
    format: 'cash',
    ante: 0,
    straddleActive: false,
  };
  return { hero, gs, controller, initial };
}
function choose(
  s: ReturnType<typeof spot>,
  phase11Omaha: 'off' | 'shadow' | 'candidate' = 'shadow'
) {
  HorseMind.reset();
  seedFastRandom(100);
  expect(s.gs.players.every((p) => p.cards.length === 0)).toBe(true);
  return HorseLogic.decide(
    s.hero,
    s.gs,
    'balanced',
    {},
    { v7AdaptiveMC: false, decisionTimeMs: 1793260000000, phase11Omaha }
  );
}
afterEach(() => HorseMind.reset());

it.each(['off', 'shadow', 'candidate'] as const)(
  'uses the same matched 82 units despite 900 surplus chips with Phase11 %s',
  (mode) => {
    const results = [100, 1000].map((initial) => {
      const s = spot(initial);
      expect(s.hero.stack).toBe(initial - 18);
      expect(s.gs.pot).toBe(72);
      expect(s.gs.toCall).toBe(36);
      expect(s.gs.players[1].stack + s.gs.players[1].bet).toBe(82);
      const d = choose(s, mode);
      expect(d).toMatchObject(
        initial === 100 ? { action: 'all_in' } : { action: 'raise', amount: 82 }
      );
      let accepted: { action: string; amount: number } | undefined;
      expect(
        s.controller.performAction(1, d.action, d.amount, 'horse_policy', (a) => {
          accepted = { action: a.action, amount: a.amount };
        })
      ).toBe(true);
      expect(accepted).toEqual({ action: d.action, amount: 82 });
      expect(
        s.controller.performAction(
          2,
          'call',
          s.controller.getAuthoritativeActionState(villainId)!.toCall,
          'player'
        )
      ).toBe(true);
      const end = s.controller.getState();
      expect(end.players.map((p) => p.totalInvested)).toEqual([100, 100]);
      expect(end.players[0].returnedUncalled ?? 0).toBe(0);
      // Actual separate physical deal: hero locks high, opponent wins low.
      expect(end.players[0].stack).toBe(initial);
      return accepted;
    });
    expect(results).toEqual([
      { action: 'all_in', amount: 82 },
      { action: 'raise', amount: 82 },
    ]);
  }
);

it.each([
  ['quarter', 'As 4h Qd Jh', 'Ks 7h 6d 3c 2s', 'Ac 4d Kh Kd', 0.25],
  ['low_only', 'As 4h Qd Jh', 'Ks 7h 6d 3c 2s', 'Ac 5d Kh Kd', 0.5],
  ['locked_high', 'Ac Qc Jh Td', board, 'As 4h 5s 9d', 0.5],
  ['nut_low_freeroll', 'Ac Qc 4h 5d', board, 'As 4d Jh Td', 0.75],
  ['scoop', 'Ac Qc 4h 5d', board, 'As 5s Jh Td', 1],
  ['no_qualifying_low', 'Ac Qc Jh Td', 'Kc Tc 9h 7c 8d', 'As 4h 5s 9d', 1],
] as const)(
  'retains independent whole-pot %s semantics (%s)',
  (_name, own, publicBoard, opponent, expectedShare) => {
    const ownCards = cards(own),
      otherCards = cards(opponent),
      publicCards = cards(publicBoard);
    const ownHigh = scoreOmahaHi(ownCards, publicCards),
      otherHigh = scoreOmahaHi(otherCards, publicCards);
    const ownLow = scoreOmahaLow(ownCards, publicCards),
      otherLow = scoreOmahaLow(otherCards, publicCards);
    const highShare = ownHigh > otherHigh ? 1 : ownHigh === otherHigh ? 0.5 : 0;
    const anyLow = ownLow !== Infinity || otherLow !== Infinity;
    const lowShare =
      ownLow === Infinity ? 0 : ownLow < otherLow ? 1 : ownLow === otherLow ? 0.5 : 0;
    const share = anyLow ? 0.5 * highShare + 0.5 * lowShare : highShare;
    expect(share).toBe(expectedShare);
    const s = spot(1000, own, publicBoard, opponent);
    // Private opponent cards are used only by this independent settlement oracle.
    expect(s.controller.performAction(1, 'call', 36, 'player')).toBe(true);
    expect(s.controller.getState().players[0].stack).toBe(1000 - 54 + 108 * expectedShare);
    expect(headsUpCashCommitment(s.hero, s.gs)).toMatchObject({
      exposure: 82,
      wager: { action: 'raise', amount: 82 },
    });
  }
);

it.each([
  ['quarter', 'As 4h Qd Jh', 'Ks 7h 6d 3c 2s', 'Ac 4d Kh Kd'],
  ['low_only', 'As 4h Qd Jh', 'Ks 7h 6d 3c 2s', 'Ac 5d Kh Kd'],
  ['non_nut_high', 'Qc Jc Ah Td', board, 'Ac 4h 5s 9d'],
] as const)(
  'does not turn the %s public-range decision into automatic value aggression',
  (_name, own, publicBoard, opponent) => {
    const decisions = [100, 1000].map((initial) =>
      choose(spot(initial, own, publicBoard, opponent))
    );
    for (const d of decisions) expect(['fold', 'call']).toContain(d.action);
    expect(decisions[1].action).toBe(decisions[0].action);
  }
);

it.each([
  { gameMode: 'tournament' as const },
  { bombPot: true },
  { boardCount: 2 as const },
  { communityCards2: cards('Ac Kd 7h') },
  { bettingStructure: 'no_limit' as const },
  { commitmentCapRemaining: 40 },
])('retains existing exclusions %j', (change) => {
  const s = spot(1000);
  Object.assign(s.gs, change);
  expect(headsUpCashCommitment(s.hero, s.gs)).toBeNull();
});
it('does not create raise rights, multiway rights or an all-in-only commitment domain', () => {
  const s = spot(1000);
  s.gs.legalActions = ['fold', 'call'];
  s.gs.minRaiseTo = null;
  s.gs.maxRaiseTo = null;
  expect(headsUpCashCommitment(s.hero, s.gs)).toMatchObject({
    exposure: 82,
    wager: { action: 'call', amount: 36 },
  });
  s.gs.players.push({ ...s.gs.players[1], seat: 3, user_id: 'third' });
  expect(headsUpCashCommitment(s.hero, s.gs)).toBeNull();
  s.gs.players.pop();
  s.gs.players[1].is_all_in = true;
  s.gs.players[1].stack = 0;
  expect(headsUpCashCommitment(s.hero, s.gs)).toBeNull();
});
it('uses the legal minimum full raise below the opponent matching ceiling and returns its excess exactly once', () => {
  for (const initial of [100, 1000]) {
    const s = spot(initial, 'Ac Qc Jh Td', board, 'As 4h 5s 9d', 74);
    const commitment = headsUpCashCommitment(s.hero, s.gs)!;
    expect(commitment).toMatchObject({ exposure: 56, wager: { action: 'raise', amount: 72 } });
    expect(
      s.controller.performAction(
        1,
        commitment.wager.action,
        commitment.wager.amount,
        'horse_policy'
      )
    ).toBe(true);
    expect(
      s.controller.performAction(
        2,
        'call',
        s.controller.getAuthoritativeActionState(villainId)!.toCall,
        'player'
      )
    ).toBe(true);
    const end = s.controller.getState();
    expect(end.players.map((p) => p.totalInvested)).toEqual([74, 74]);
    expect(end.players[0].returnedUncalled).toBe(16);
    expect(end.players[0].stack).toBe(initial);
  }
});
it('keeps a physical under-minimum all-in distinct from a covering minimum raise', () => {
  const short = spot(74, 'Ac Qc Jh Td', board, 'As 4h 5s 9d', 74);
  const covering = spot(1000, 'Ac Qc Jh Td', board, 'As 4h 5s 9d', 74);
  expect(short.gs.legalActions).not.toContain('raise');
  expect(short.gs.legalActions).toContain('all_in');
  expect(covering.gs.legalActions).toContain('raise');
  expect(headsUpCashCommitment(short.hero, short.gs)).toMatchObject({
    exposure: 56,
    wager: { action: 'all_in' },
  });
  expect(headsUpCashCommitment(covering.hero, covering.gs)).toMatchObject({
    exposure: 56,
    wager: { action: 'raise', amount: 72 },
  });
  for (const s of [short, covering]) {
    const d = choose(s);
    expect(d).toMatchObject(s === short ? { action: 'all_in' } : { action: 'raise', amount: 72 });
    expect(s.controller.performAction(1, d.action, d.amount, 'horse_policy')).toBe(true);
    expect(
      s.controller.performAction(
        2,
        'call',
        s.controller.getAuthoritativeActionState(villainId)!.toCall,
        'player'
      )
    ).toBe(true);
    const end = s.controller.getState();
    expect(end.players.map((p) => p.totalInvested)).toEqual([74, 74]);
    expect(end.players[0].totalInvested - 18).toBe(56);
    expect(end.players[0].returnedUncalled ?? 0).toBe(s === short ? 0 : 16);
    expect(end.players[0].stack).toBe(s.initial);
  }
});
