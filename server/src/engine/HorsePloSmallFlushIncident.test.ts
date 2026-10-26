import { afterEach, describe, expect, it, vi } from 'vitest';
import fixture from './fixtures/horse-plo5-small-flush-45855223.json';
import { HorseLogic, type HorseGameStateV2 } from './HorseLogic.js';
import { enableBrainTelemetry, drainFires } from './BrainTelemetry.js';
import { HorseMind } from './HorseMind.js';
import { seedFastRandom } from './HorseEval.js';
import { calculateContestablePot, calculatePots, Deck } from './PokerEngine.js';
import { HandController } from './HandController.js';
import { horseVariantRulesFor } from './VariantRules.js';
import type { HorsePublicActionNode } from './HorsePublicActionNode.js';
import type { ActionRecord, Card, HandConfig, HorseStyle, SeatPlayer } from '../types.js';

type Variant = 'plo4' | 'plo5' | 'plo6' | 'plo8';
type Captured = Extract<HorsePublicActionNode, { status: 'captured' }>;
const actions = fixture.actions as unknown as Array<ActionRecord & { publicNode?: Captured }>;
const holdings = fixture.heroCards as Record<string, Card[]>;
const styles: HorseStyle[] = ['tag', 'lag', 'balanced', 'tricky', 'grinder'];
const variants: Variant[] = ['plo4', 'plo5', 'plo6', 'plo8'];
const bySeat = new Map(actions.map((action) => [action.seat, action.userId]));

/** Accepted public controller nodes and this actor's revealed cards only.
 * The other seats retain empty cards, including WooWoo. Historical read frames
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
  // The extra card removed/added is unrelated to the flush or public board.
  if (variant === 'plo4' || variant === 'plo8') ownCards.splice(3, 1);
  if (variant === 'plo6') ownCards.push({ rank: '3', suit: 'clubs' });
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
    blindSeats: { smallBlind: 3, bigBlind: 5 },
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
    minRaise: ordinal <= 19 ? n.bigBlind : 160,
    lastRaise: ordinal <= 19 ? n.bigBlind : 160,
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

/** Real controller records: actor1 bets4, actor2 calls4, actor3 raises TO8,
 * actor1 jams TO10 (short raise) or TO8 (all-in call). The controlled physical
 * deck gives actor2 the reported small flush without exposing other holdings
 * to HorseLogic. All action validation, menus, pots and public nodes are real. */
function controllerRiverPriceChain(firstStack: 10 | 12, jamCaller = false) {
  const parse = (text: string): Card =>
    ({
      rank: text[0],
      suit: ({ s: 'spades', h: 'hearts', d: 'diamonds', c: 'clubs' } as Record<string, string>)[
        text[1]
      ],
    }) as Card;
  const prefix = [
    'As',
    'Ac',
    'Ks',
    'Kc',
    'Ts',
    'Qh',
    '2d',
    '5h',
    'Jh',
    '9d',
    '7c',
    '7s',
    '8h',
    'Th',
    '3c',
    '6d',
    'Jd',
    'Qd',
    '8c',
    '9s',
  ].map(parse);
  const shuffle = vi.spyOn(Deck.prototype, 'shuffle').mockImplementation(function (this: Deck) {
    const cards = (this as unknown as { cards: Card[] }).cards;
    const rest = cards.filter((c) => !prefix.some((p) => p.rank === c.rank && p.suit === c.suit));
    cards.splice(0, cards.length, ...prefix, ...rest);
  });
  const config: HandConfig = {
    tableId: '20000000-0000-4000-8000-000000000001',
    handNumber: 1,
    gameVariant: 'plo5',
    smallBlind: 1,
    bigBlind: 2,
    ante: 0,
    rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
  };
  const players: SeatPlayer[] = [1, 2, 3].map(
    (seat) =>
      ({
        seat,
        user_id: `20000000-0000-4000-8000-00000000000${seat}`,
        username: `Seat ${seat}`,
        stack: seat === (jamCaller ? 2 : 1) ? firstStack : 100,
        bet: 0,
        totalInvested: 0,
        cards: [],
        is_folded: false,
        is_all_in: false,
        is_sitting_out: false,
      }) as SeatPlayer
  );
  const controller = new HandController(config, players, 3);
  try {
    controller.start();
  } finally {
    shuffle.mockRestore();
  }
  for (const seat of [3, 1]) expect(controller.performAction(seat, 'call')).toBe(true);
  expect(controller.performAction(2, 'check')).toBe(true);
  while (controller.getState().stage !== 'river') {
    const actor = controller.getCurrentPlayer();
    if (!actor) throw Error('controller did not reach river');
    expect(controller.performAction(actor.seat, 'check')).toBe(true);
  }
  expect(controller.performAction(1, 'bet', 4)).toBe(true);
  expect(controller.performAction(2, 'call')).toBe(true);
  expect(controller.performAction(3, 'raise', 8)).toBe(true);
  if (jamCaller) expect(controller.performAction(1, 'call')).toBe(true);
  expect(controller.performAction(jamCaller ? 2 : 1, 'all_in')).toBe(true);
  const live = controller.getState();
  const actor = controller.getCurrentPlayer();
  if (!actor) throw Error('missing real controller actor');
  const menu = controller.getAuthoritativeActionState(actor.user_id);
  if (!menu?.canAct) throw Error('missing real controller decision menu');
  const hero: SeatPlayer = {
    ...actor,
    cards: actor.cards.map((c) => ({ ...c })),
    knownDeadCards: [],
  };
  const state: HorseGameStateV2 = {
    stateSchemaVersion: 1,
    dealtSeatIds: live.players.filter((p) => p.cards.length > 0).map((p) => p.seat),
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
    contestablePot: calculateContestablePot(live.players, actor.user_id, menu.toCall),
    rakeConfig: controller.getRakeConfigSnapshot(),
    variantRules: horseVariantRulesFor('plo5'),
    players: live.players.map((p) => {
      const { knownDeadCards: _private, ...publicPlayer } = p;
      return { ...publicPlayer, cards: [] };
    }),
    communityCards: [...live.communityCards],
    communityCards2: [],
    communityCards3: [],
    bombPot: false,
    boardCount: 1,
    pot: live.pot,
    currentBet: live.currentBet,
    minRaise: live.minRaise,
    lastRaise: live.lastRaise,
    stage: live.stage,
    gameVariant: 'plo5',
    bigBlind: config.bigBlind,
    dealerSeat: live.dealerSeat,
    actionHistory: live.actionHistory.map((a) => ({ ...a })),
    gameMode: 'cash',
    format: 'cash',
    ante: config.ante ?? 0,
    straddleActive: false,
  };
  expect(hero.seat).toBe(jamCaller ? 3 : 2);
  return { hero, state };
}

function decide(ordinal: number, variant: Variant, style: HorseStyle, seed: number, nuts = false) {
  HorseMind.reset();
  seedFastRandom(100 + seed);
  const spot = incident(ordinal, variant);
  if (nuts) {
    spot.hero.cards[0] = { rank: 'A', suit: 'diamonds' };
    spot.hero.cards[1] = { rank: '4', suit: 'diamonds' };
  }
  return HorseLogic.decide(spot.hero, spot.state, style, {}, { telemetry: false });
}

afterEach(() => {
  HorseMind.reset();
  drainFires();
});

describe('reported PLO5 small-flush hand 45855223', () => {
  it('preserves the real short raise, main-pot eligibility and cheap final call', () => {
    expect(actions[20].isFullRaise).toBe(false);
    const cole = incident(21);
    expect(cole.state.toCall).toBe(181.75);
    expect(cole.hero.stack).toBe(135.05);
    expect(cole.state.contestablePot).toBe(538.1);
    expect(incident(22).state.toCall).toBe(21.75);
    expect(incident(22).state.contestablePot).toBe(744.8);
    expect(cole.state.players.every((player) => player.cards.length === 0)).toBe(true);
  });

  function features(spot: ReturnType<typeof incident>) {
    HorseMind.reset();
    seedFastRandom(100);
    enableBrainTelemetry();
    drainFires();
    HorseLogic.decide(spot.hero, spot.state, 'balanced', {}, { telemetry: true });
    return drainFires().map((row) => row.feature);
  }

  it('distinguishes controller street-total short raises from all-in calls', () => {
    const key = 'horse_continuation_omaha_cold_flush_pressure';
    expect(features(incident(21))).toContain(key);
    const call = incident(21);
    call.state.actionHistory = call.state.actionHistory!.map((a, i) =>
      i === 20 ? { ...a, amount: 160 } : a
    );
    expect(features(call)).not.toContain(key);
    const shortRaise = controllerRiverPriceChain(12);
    const river = shortRaise.state.actionHistory!.filter((a) => a.stage === 'river');
    expect(river.map((a) => [a.action, a.amount])).toEqual([
      ['bet', 4],
      ['call', 4],
      ['raise', 8],
      ['all_in', 10],
    ]);
    expect(river.at(-1)!.isFullRaise).toBe(false);
    expect(features(shortRaise)).toContain(key);
    const matchedAllIn = controllerRiverPriceChain(10);
    const matched = matchedAllIn.state.actionHistory!.filter((a) => a.stage === 'river');
    expect(matched.map((a) => [a.action, a.amount])).toEqual([
      ['bet', 4],
      ['call', 4],
      ['raise', 8],
      ['all_in', 8],
    ]);
    expect(matched.at(-1)!.isFullRaise).toBeUndefined();
    expect(features(matchedAllIn)).not.toContain(key);
    // A player who first CALLED4 and then jams also records TOTAL10,
    // not the six additional chips paid. Capture that producer contract too.
    const priorCall = controllerRiverPriceChain(12, true);
    const calledThenJammed = priorCall.state.actionHistory!.filter((a) => a.stage === 'river');
    expect(calledThenJammed.map((a) => [a.action, a.amount])).toEqual([
      ['bet', 4],
      ['call', 4],
      ['raise', 8],
      ['call', 4],
      ['all_in', 10],
    ]);
    expect(calledThenJammed[1].userId).toBe(calledThenJammed[4].userId);
    expect(calledThenJammed.at(-1)!.isFullRaise).toBe(false);
  });

  it('excludes unrelated side-pot aggression and earlier streets', () => {
    const key = 'horse_continuation_omaha_cold_flush_pressure';
    const isolated = incident(21);
    isolated.state.pots = [
      { amount: 538.1, eligiblePlayers: [isolated.hero.user_id, actions[19].userId] },
    ];
    expect(features(isolated)).not.toContain(key);
    const earlier = incident(21);
    earlier.state.stage = 'turn';
    earlier.state.communityCards = earlier.state.communityCards.slice(0, 4);
    expect(features(earlier)).not.toContain(key);
  });

  it('does not impose the called-through check when one caller has folded', () => {
    const spot = incident(19);
    spot.state.players.find((p) => p.user_id === actions[21].userId)!.is_folded = true;
    expect(features(spot)).not.toContain('horse_continuation_omaha_called_through_flush_check');
  });

  it('preserves genuine split-low and multi-board paths', () => {
    for (const multi of [false, true]) {
      const spot = incident(21, multi ? 'plo5' : 'plo8');
      if (multi) {
        spot.state.boardCount = 2;
        spot.state.communityCards2 = spot.state.communityCards.map((c) => ({ ...c }));
      } else
        spot.state.communityCards = [
          { rank: '3', suit: 'diamonds' },
          { rank: '4', suit: 'diamonds' },
          { rank: '7', suit: 'diamonds' },
          { rank: '8', suit: 'clubs' },
          { rank: '9', suit: 'spades' },
        ];
      expect(features(spot)).not.toContain('horse_continuation_omaha_cold_flush_pressure');
    }
  });

  for (const variant of variants) {
    it(`${variant}: checks the third-nut flush after both live opponents called two streets`, () => {
      for (const style of styles)
        for (let seed = 0; seed < 4; seed++)
          expect(decide(19, variant, style, seed).action, `${style}/${seed}`).toBe('check');
    });

    it(`${variant}: retains value betting with a second-nut flush`, () => {
      for (const style of styles) {
        HorseMind.reset();
        seedFastRandom(100);
        const spot = incident(19, variant);
        spot.hero.cards[spot.hero.cards.length === 4 ? 3 : 4] = { rank: 'K', suit: 'diamonds' };
        expect(['bet', 'all_in']).toContain(
          HorseLogic.decide(spot.hero, spot.state, style, {}, { telemetry: false }).action
        );
      }
    });
    it(`${variant}: declines the cold stack-off with a dominated low flush after a bet and short jam`, () => {
      for (const style of styles)
        for (let seed = 0; seed < 4; seed++)
          expect(decide(21, variant, style, seed).action, `${style}/${seed}`).toBe('fold');
    });

    it(`${variant}: retains the cheap final call after hero has already bet`, () => {
      for (const style of styles)
        for (let seed = 0; seed < 3; seed++)
          expect(decide(22, variant, style, seed).action, `${style}/${seed}`).toBe('call');
    });

    it(`${variant}: still bets the actual nut flush when checked to`, () => {
      for (const style of styles)
        for (let seed = 0; seed < 3; seed++)
          expect(['bet', 'all_in']).toContain(decide(19, variant, style, seed, true).action);
    });
  }
});
