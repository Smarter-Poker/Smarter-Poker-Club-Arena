import { afterEach, describe, expect, it } from 'vitest';
import type { Card, SeatPlayer } from '../types.js';
import { HorseLogic, type HorseGameStateV2 } from './HorseLogic.js';
import { HorseMind } from './HorseMind.js';
import { seedFastRandom } from './HorseEval.js';
import { headsUpCashCommitment } from './HorseHeadsUpCommitment.js';
import { HandController } from './HandController.js';
import { horsePlanHandKey } from './HorseDecisionEffects.js';
import { applyTableCommitmentCap } from './ServerTableEngineTurns.js';

const cards = (s: string): Card[] =>
  s.split(' ').map((c) => ({
    rank: c[0] as Card['rank'],
    suit: ({ c: 'clubs', d: 'diamonds', h: 'hearts', s: 'spades' } as const)[c[1] as 'c'],
  }));
function spot(stack: number) {
  const hero: SeatPlayer = {
    seat: 1,
    user_id: 'hero',
    username: 'Hero',
    stack,
    bet: 0,
    totalInvested: 10,
    is_folded: false,
    is_all_in: false,
    is_sitting_out: false,
    cards: cards('Ac Qd'),
  };
  const villain: SeatPlayer = {
    ...hero,
    seat: 2,
    user_id: 'villain',
    stack: 15,
    bet: 20,
    totalInvested: 30,
    cards: [],
  };
  const gs: HorseGameStateV2 = {
    stateSchemaVersion: 1,
    players: [{ ...hero, cards: [] }, villain],
    communityCards: cards('Qs 8h 3d'),
    dealtSeatIds: [1, 2],
    dealerSeat: 2,
    pot: 40,
    contestablePot: 40,
    currentBet: 20,
    minRaise: 20,
    lastRaise: 20,
    stage: 'flop',
    gameVariant: 'nlh',
    gameMode: 'cash',
    smallBlind: 1,
    bigBlind: 2,
    toCall: 20,
    legalActions: stack < 40 ? ['fold', 'call', 'all_in'] : ['fold', 'call', 'raise', 'all_in'],
    minRaiseTo: stack < 40 ? null : 40,
    maxRaiseTo: stack < 40 ? null : stack,
    bettingStructure: 'no_limit',
    actionHistory: [
      { stage: 'flop', seat: 1, userId: 'hero', action: 'check', amount: 0, timestamp: 1 },
      { stage: 'flop', seat: 2, userId: 'villain', action: 'bet', amount: 20, timestamp: 2 },
    ],
  };
  return { hero, gs };
}
afterEach(() => HorseMind.reset());
describe('cash heads-up matched commitment', () => {
  it('does not turn the existing low-SPR wager into a call because hero covers surplus chips', () => {
    const choices = [35, 1000].map((stack) => {
      HorseMind.reset();
      seedFastRandom(1);
      const s = spot(stack);
      return HorseLogic.decide(s.hero, s.gs, 'balanced', {}, { v7AdaptiveMC: false });
    });
    expect(choices[0].action).toBe('all_in');
    expect(choices[1]).toMatchObject({ action: 'raise', amount: 40 });
  });

  it.each(['flop', 'turn', 'river'] as const)(
    'preserves callOnce on %s when facing a raise',
    (street) => {
      for (const stack of [35, 1000]) {
        HorseMind.reset();
        seedFastRandom(1);
        const s = spot(stack);
        s.gs.stage = street;
        s.gs.communityCards = cards(
          street === 'flop' ? 'Qs 8h 3d' : street === 'turn' ? 'Qs 8h 3d 2s' : 'Qs 8h 3d 2s 6h'
        );
        s.hero.bet = 5;
        s.hero.totalInvested = 15;
        s.gs.players[0] = { ...s.hero, cards: [] };
        s.gs.toCall = 15;
        s.gs.pot = 45;
        s.gs.contestablePot = 45;
        s.gs.actionHistory = [
          { stage: street, seat: 1, userId: 'hero', action: 'bet', amount: 5, timestamp: 1 },
          { stage: street, seat: 2, userId: 'villain', action: 'raise', amount: 20, timestamp: 2 },
        ];
        HorseMind.noteRaisePlan(horsePlanHandKey(s.gs.actionHistory), 'hero', street, 'callOnce');
        expect(
          HorseLogic.decide(s.hero, s.gs, 'balanced', {}, { v7AdaptiveMC: false }).action
        ).toBe('call');
      }
    }
  );

  it('never creates raise rights when the canonical menu offers only a call', () => {
    const s = spot(1000);
    s.gs.legalActions = ['fold', 'call'];
    s.gs.minRaiseTo = null;
    s.gs.maxRaiseTo = null;
    expect(headsUpCashCommitment(s.hero, s.gs)).toMatchObject({
      exposure: 35,
      wager: { action: 'call', amount: 20 },
    });
    seedFastRandom(1);
    expect(HorseLogic.decide(s.hero, s.gs, 'balanced', {}, { v7AdaptiveMC: false }).action).toBe(
      'call'
    );
  });

  it('retains the existing policy for a binding whole-hand commitment cap', () => {
    const s = spot(1000);
    s.gs.commitmentCapRemaining = 30;
    s.gs.legalActions = ['fold', 'call'];
    s.gs.minRaiseTo = null;
    s.gs.maxRaiseTo = null;
    expect(headsUpCashCommitment(s.hero, s.gs)).toBeNull();
  });
  it.each([0, 10, 35, NaN, -1])(
    'rejects a binding or malformed cap %s even if supplied call rights disagree',
    (cap) => {
      const s = spot(1000);
      s.gs.commitmentCapRemaining = cap;
      expect(headsUpCashCommitment(s.hero, s.gs)).toBeNull();
    }
  );
  it('rejects opponent exposure below the effective call and an inconsistent call price', () => {
    const s = spot(1000);
    s.gs.players[1].bet = 1;
    s.gs.players[1].stack = 1;
    expect(headsUpCashCommitment(s.hero, s.gs)).toBeNull();
    s.gs.players[1].bet = 20;
    s.gs.players[1].stack = 15;
    s.gs.toCall = 5;
    expect(headsUpCashCommitment(s.hero, s.gs)).toBeNull();
  });
  it('admits a nonbinding cap with the same bounded intent', () => {
    const s = spot(1000);
    s.gs.commitmentCapRemaining = 1000;
    expect(headsUpCashCommitment(s.hero, s.gs)?.wager).toMatchObject({
      action: 'raise',
      amount: 40,
    });
  });

  it('ignores folded covering chips but excludes every additional showdown contender', () => {
    const s = spot(1000);
    s.gs.players.push({
      ...s.gs.players[1],
      seat: 3,
      user_id: 'third',
      stack: 9999,
      is_folded: true,
    });
    expect(headsUpCashCommitment(s.hero, s.gs)?.exposure).toBe(35);
    s.gs.players[2].is_folded = false;
    expect(headsUpCashCommitment(s.hero, s.gs)).toBeNull();
    s.gs.players[2].stack = 0;
    s.gs.players[2].is_all_in = true;
    s.gs.players[2].is_sitting_out = true;
    expect(headsUpCashCommitment(s.hero, s.gs)).toBeNull();
  });

  it.each(['plo8', 'flh', 'flo8', 'short_deck', 'pineapple'])(
    'retains the existing %s policy',
    (variant) => {
      const s = spot(1000);
      s.gs.gameVariant = variant;
      expect(headsUpCashCommitment(s.hero, s.gs)).toBeNull();
    }
  );
  it.each([
    { gameMode: 'tournament' as const },
    { stateSchemaVersion: undefined },
    { bettingStructure: 'pot_limit' as const },
    { bombPot: true },
    { boardCount: 2 as const },
    { communityCards2: cards('Ac Kd 7h') },
    { legalActions: undefined },
  ])('leaves unqualified domains unchanged: %j', (change) => {
    const s = spot(1000);
    Object.assign(s.gs, change);
    expect(headsUpCashCommitment(s.hero, s.gs)).toBeNull();
  });
  it('retains the all-in-only opponent policy', () => {
    const s = spot(1000);
    s.gs.players[1].is_all_in = true;
    s.gs.players[1].stack = 0;
    expect(headsUpCashCommitment(s.hero, s.gs)).toBeNull();
  });
  it.each([0, NaN, -1, 0.1])('refuses invalid chip unit %s', (unit) => {
    const s = spot(1000);
    Object.assign(s.gs, { chipUnit: unit });
    expect(headsUpCashCommitment(s.hero, s.gs)).toBeNull();
  });
  it('rounds up to a legal chip unit without rounding below the minimum', () => {
    const s = spot(1000);
    s.gs.minRaiseTo = 40.005;
    expect(headsUpCashCommitment(s.hero, s.gs)?.wager.amount).toBe(40.01);
    s.gs.maxRaiseTo = 40;
    expect(headsUpCashCommitment(s.hero, s.gs)?.wager.action).toBe('call');
    s.gs.chipUnit = 1;
    s.gs.minRaiseTo = 40.1;
    s.gs.maxRaiseTo = 40.6;
    expect(headsUpCashCommitment(s.hero, s.gs)?.wager.action).toBe('call');
  });

  it('prices a retained foldToRaise plan against the same matched exposure', () => {
    const choices = [35, 1000].map((stack) => {
      HorseMind.reset();
      seedFastRandom(1);
      const s = spot(stack);
      s.hero.bet = 5;
      s.hero.totalInvested = 20;
      s.gs.players[0] = { ...s.hero, cards: [] };
      s.gs.players[1].stack = 20;
      s.gs.players[1].totalInvested = 35;
      s.gs.pot = 55;
      s.gs.contestablePot = 55;
      s.gs.toCall = 15;
      s.gs.minRaise = 15;
      s.gs.lastRaise = 15;
      s.gs.minRaiseTo = 35;
      s.gs.maxRaiseTo = stack + 5;
      s.gs.legalActions = ['fold', 'call', 'raise', 'all_in'];
      s.gs.actionHistory = [
        { stage: 'flop', seat: 1, userId: 'hero', action: 'bet', amount: 5, timestamp: 1 },
        { stage: 'flop', seat: 2, userId: 'villain', action: 'raise', amount: 20, timestamp: 2 },
      ];
      HorseMind.noteRaisePlan(horsePlanHandKey(s.gs.actionHistory), 'hero', 'flop', 'foldToRaise');
      return HorseLogic.decide(s.hero, s.gs, 'balanced', {}, { v7AdaptiveMC: false });
    });
    expect(choices.map((d) => d.action)).toEqual(['call', 'call']);
  });

  it('uses actual controller menus and matches the same 35 units after acceptance and refund', () => {
    const results = [45, 1010].map((initial) => {
      const s = spot(initial);
      const controller = new HandController(
        {
          tableId: 'isolated-effective-risk',
          handNumber: 1,
          gameVariant: 'nlh',
          smallBlind: 1,
          bigBlind: 2,
          rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
        },
        [
          { ...s.hero, stack: initial },
          { ...s.gs.players[1], stack: 45 },
        ],
        2
      );
      controller.start();
      for (const [seat, action, amount] of [
        [2, 'raise', 10],
        [1, 'call', 8],
        [1, 'check', undefined],
        [2, 'bet', 20],
      ] as const)
        expect(controller.performAction(seat, action, amount, 'player')).toBe(true);
      const state = controller.getState();
      const hero = state.players.find((p) => p.seat === 1)!;
      const auth = controller.getAuthoritativeActionState('hero')!;
      if (initial === 1010) {
        const capped = applyTableCommitmentCap(auth, hero, true, 20, 2);
        expect(capped.commitmentCapRemaining).toBe(30);
        expect(capped.legalActions).toEqual(['fold', 'call']);
        expect(
          headsUpCashCommitment(hero, { ...s.gs, ...capped, players: state.players })
        ).toBeNull();
        const belowCall = applyTableCommitmentCap(auth, hero, true, 10, 2);
        expect(belowCall.commitmentCapRemaining).toBe(10);
        expect(belowCall.legalActions).toEqual(['fold']);
      }
      const gs = {
        ...s.gs,
        ...auth,
        players: state.players,
        contestablePot: controller.getContestablePotForCall('hero')!,
        commitmentCapRemaining: null,
      };
      const decision = headsUpCashCommitment(hero, gs)!.wager;
      expect(controller.performAction(1, decision.action, decision.amount, 'horse_policy')).toBe(
        true
      );
      expect(
        controller.performAction(
          2,
          'call',
          controller.getAuthoritativeActionState('villain')!.toCall,
          'player'
        )
      ).toBe(true);
      const end = controller.getState();
      expect(end.pot).toBe(90);
      expect(end.players.map((p) => p.totalInvested)).toEqual([45, 45]);
      return { decision, returned: end.players[0].returnedUncalled };
    });
    expect(results).toEqual([
      { decision: { action: 'all_in', thinkTime: 0 }, returned: 0 },
      { decision: { action: 'raise', amount: 40, thinkTime: 0 }, returned: 5 },
    ]);
  });
});

function omahaSpot(variant: 'plo4' | 'plo5' | 'plo6', stack: number, hole: string, board: string) {
  const base = spot(stack);
  const controller = new HandController(
    {
      tableId: 'isolated-plo-matched-risk',
      handNumber: 1,
      gameVariant: variant,
      smallBlind: 1,
      bigBlind: 2,
      rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
    },
    [
      { ...base.hero, stack: stack + 18, bet: 0, totalInvested: 0, cards: [] },
      { ...base.gs.players[1], stack: 53, bet: 0, totalInvested: 0, cards: [] },
    ],
    2
  );
  controller.start();
  for (const [seat, action, amount] of [
    [2, 'raise', 6],
    [1, 'call', 4],
    [1, 'check', undefined],
    [2, 'bet', 12],
    [1, 'call', 12],
    [1, 'check', undefined],
    [2, 'bet', 20],
  ] as const)
    expect(controller.performAction(seat, action, amount, 'player')).toBe(true);
  const state = controller.getState();
  const auth = controller.getAuthoritativeActionState('hero')!;
  // Natural controller establishes chip/action geometry; fixed cards below
  // exercise the chooser separately, without injecting its private deck.
  const hero = { ...state.players.find((p) => p.seat === 1)!, cards: cards(hole) };
  const gs: HorseGameStateV2 = {
    ...base.gs,
    ...auth,
    players: state.players.map((p) => ({ ...p, cards: [] })),
    communityCards: cards(board),
    pot: state.pot,
    contestablePot: controller.getContestablePotForCall('hero')!,
    currentBet: state.currentBet,
    lastRaise: state.lastRaise,
    minRaise: auth.minRaiseTo == null ? state.lastRaise : auth.minRaiseTo - state.currentBet,
    stage: 'turn',
    gameVariant: variant,
    bettingStructure: auth.structure,
    actionHistory: state.actionHistory.map((a, i) => ({
      stage: a.stage,
      seat: a.seat,
      userId: a.userId,
      action: a.action,
      amount: a.amount,
      isFullRaise: a.isFullRaise,
      timestamp: i + 1,
    })),
  };
  return { hero, gs, controller };
}

describe('high-only cash Omaha matched commitment', () => {
  it.each([
    ['plo4', 'Qc Qd Ah Kh', 'Qs 8h 3d 2c', 1],
    ['plo5', 'Ad Kd Qh Jc 3c', '9d 6d 2s 3d', 2],
    ['plo5', '9h 9c Ad Kd 3c', '9d 2d 2s 5c', 1],
  ] as const)('preserves matched-risk pressure for %s %s', (variant, hole, board, seed) => {
    const results = [35, 1000].map((stack) => {
      const s = omahaSpot(variant, stack, hole, board);
      HorseMind.reset();
      seedFastRandom(seed);
      const d = HorseLogic.decide(s.hero, s.gs, 'balanced', {}, { v7AdaptiveMC: false });
      expect(d).toMatchObject(
        stack === 35 ? { action: 'all_in' } : { action: 'raise', amount: 40 }
      );
      let accepted: { action: string; amount?: number } | undefined;
      expect(
        s.controller.performAction(1, d.action, d.amount, 'horse_policy', (a) => {
          accepted = { action: a.action, amount: a.amount };
        })
      ).toBe(true);
      expect(accepted?.action).toBe(d.action);
      if (d.action === 'raise') expect(accepted?.amount).toBe(d.amount);
      expect(
        s.controller.performAction(
          2,
          'call',
          s.controller.getAuthoritativeActionState('villain')!.toCall,
          'player'
        )
      ).toBe(true);
      const end = s.controller.getState();
      expect(end.pot).toBe(106);
      expect(end.players.map((p) => p.totalInvested)).toEqual([53, 53]);
      return d;
    });
    expect(results[0].action).toBe('all_in');
    expect(results[1]).toMatchObject({ action: 'raise', amount: 40 });
  });
  it.each(['plo4', 'plo5', 'plo6'] as const)('preserves dominated-flush flats in %s', (variant) => {
    for (const stack of [35, 1000]) {
      const hole = '7d 5d Ah Kc 3c 2h'
        .split(' ')
        .slice(0, Number(variant.slice(3)))
        .join(' ');
      const s = omahaSpot(variant, stack, hole, 'Kd 9d 2s 3d');
      HorseMind.reset();
      seedFastRandom(1);
      expect(HorseLogic.decide(s.hero, s.gs, 'balanced', {}, { v7AdaptiveMC: false }).action).toBe(
        'call'
      );
    }
  });

  it.each(['plo4', 'plo5', 'plo6'] as const)(
    'bounds %s intent to the canonical pot ceiling',
    (variant) => {
      const s = omahaSpot(variant, 1000, 'Qc Qd Ah Kh', 'Qs 8h 3d 2c');
      s.gs.players[1].stack = 162;
      expect(headsUpCashCommitment(s.hero, s.gs)).toMatchObject({
        exposure: 182,
        wager: { action: 'raise', amount: 96 },
      });
      s.hero.stack = 182;
      expect(headsUpCashCommitment(s.hero, s.gs)?.wager).toMatchObject({
        action: 'raise',
        amount: 96,
      });
      s.gs.maxRaiseTo = 95.995;
      expect(headsUpCashCommitment(s.hero, s.gs)?.wager.amount).toBe(95.99);
      s.gs.legalActions = ['fold', 'call'];
      s.gs.minRaiseTo = null;
      s.gs.maxRaiseTo = null;
      expect(headsUpCashCommitment(s.hero, s.gs)?.wager.action).toBe('call');
      s.gs.players[1].is_all_in = true;
      s.gs.players[1].stack = 0;
      expect(headsUpCashCommitment(s.hero, s.gs)).toBeNull();
    }
  );

  it.each(['plo4', 'plo5', 'plo6'] as const)(
    'preserves genuine short-allin no-reopen exclusion in %s',
    (variant) => {
      const s = spot(1018);
      const controller = new HandController(
        {
          tableId: 'isolated-plo-no-reopen',
          handNumber: 1,
          gameVariant: variant,
          smallBlind: 1,
          bigBlind: 2,
          rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
        },
        [
          { ...s.hero, stack: 1018, bet: 0, totalInvested: 0, cards: [] },
          { ...s.gs.players[1], stack: 24, bet: 0, totalInvested: 0 },
          {
            ...s.hero,
            seat: 3,
            user_id: 'third',
            stack: 1018,
            bet: 0,
            totalInvested: 0,
            cards: [],
          },
        ],
        3
      );
      controller.start();
      for (const [seat, action, amount] of [
        [3, 'raise', 6],
        [1, 'call', 5],
        [2, 'call', 4],
        [1, 'check', undefined],
        [2, 'check', undefined],
        [3, 'bet', 12],
        [1, 'call', 12],
        [2, 'all_in', undefined],
      ] as const)
        expect(controller.performAction(seat, action, amount, 'player')).toBe(true);
      const state = controller.getState();
      const auth = controller.getAuthoritativeActionState('third')!;
      expect(auth.legalActions).toEqual(['fold', 'call']);
      expect(
        headsUpCashCommitment(state.players.find((p) => p.seat === 3)!, {
          ...s.gs,
          ...auth,
          players: state.players,
          gameVariant: variant,
          bettingStructure: auth.structure,
        })
      ).toBeNull();
    }
  );

  it.each(['plo4', 'plo5', 'plo6'] as const)(
    'honors retained callOnce in %s before commitment',
    (variant) => {
      for (const stack of [35, 1000]) {
        const hole = 'Qc Qd Ah Kh 3c 2h'
          .split(' ')
          .slice(0, Number(variant.slice(3)))
          .join(' ');
        const s = omahaSpot(variant, stack, hole, 'Qs 8h 3d 2c');
        s.hero.bet = 5;
        s.gs.players[0] = { ...s.hero, cards: [] };
        s.gs.toCall = 15;
        s.gs.pot += 5;
        s.gs.contestablePot = s.gs.pot;
        s.gs.actionHistory = [
          { stage: 'turn', seat: 1, userId: 'hero', action: 'bet', amount: 5, timestamp: 1 },
          { stage: 'turn', seat: 2, userId: 'villain', action: 'raise', amount: 20, timestamp: 2 },
        ];
        HorseMind.reset();
        seedFastRandom(1);
        HorseMind.noteRaisePlan(horsePlanHandKey(s.gs.actionHistory), 'hero', 'turn', 'callOnce');
        expect(
          HorseLogic.decide(s.hero, s.gs, 'balanced', {}, { v7AdaptiveMC: false }).action
        ).toBe('call');
      }
    }
  );
});
