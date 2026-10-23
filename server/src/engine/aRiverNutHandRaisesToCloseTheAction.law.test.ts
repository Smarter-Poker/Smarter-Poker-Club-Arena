import { describe, expect, it } from 'vitest';
import type { Card, GameVariant, GameState } from '../types.js';
import { HorseLogic } from './HorseLogic.js';
import { seedFastRandom, variantInfo } from './HorseEval.js';
import { jointPolicyFixture } from './multiway/JointRangeFixture.test-support.js';
import { hasRiverNuts, riverNutsRaise, fullPotNearPotWager } from './HorseRiverNuts.js';
import { HandController } from './HandController.js';

const cards = (s: string): Card[] =>
  s.split(' ').map((c) => ({
    rank: c[0] as Card['rank'],
    suit: ({ c: 'clubs', d: 'diamonds', h: 'hearts', s: 'spades' } as const)[c[1] as 'c'],
  }));

function incident(variant: GameVariant = 'plo5') {
  const { hero, state } = jointPolicyFixture(variant, 1, 'cash', 'river');
  hero.cards = cards(
    variant === 'plo6' ? '7c 5d Ac Kh Qh Td' : variant === 'plo5' ? '7c 5d Ac Kh Qh' : '7c 5d Ac Kh'
  );
  hero.stack = 275.5;
  hero.bet = 0;
  state.communityCards = cards('2d 3s 6s Jh 4d');
  state.players = [
    hero,
    { ...state.players[1], bet: 50, stack: 690.7 },
    { ...state.players[2], is_folded: true },
    { ...state.players[3], is_folded: true },
  ];
  Object.assign(state, {
    pot: 169,
    currentBet: 50,
    toCall: 50,
    minRaise: 50,
    lastRaise: 50,
    minRaiseTo: 100,
    maxRaiseTo: 269,
    legalActions: ['fold', 'call', 'raise'],
    dealerSeat: 4,
  });
  return { hero, state };
}

describe('the river nuts never flat-call to close a legally raisable pot', () => {
  it('submits the incident raise through the real HandController menu and validator', () => {
    const { hero, state } = incident();
    const controller = new HandController(
      {
        tableId: 'river-nuts-isolated',
        handNumber: 44826179,
        gameVariant: 'plo5',
        smallBlind: 1,
        bigBlind: 2,
        rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
      },
      state.players,
      4
    );
    const internal = controller as unknown as {
      state: GameState;
      handFSM: { transition(s: string): void };
    };
    Object.assign(internal.state, {
      players: state.players,
      communityCards: state.communityCards,
      stage: 'river',
      currentBet: 50,
      pot: 169,
      minRaise: 50,
      lastRaise: 50,
      currentPlayerSeat: hero.seat,
    });
    for (const s of ['posting_blinds', 'dealing', 'preflop', 'flop', 'turn', 'river'])
      internal.handFSM.transition(s);
    const menu = controller.getAuthoritativeActionState(hero.user_id)!;
    expect(menu.legalActions).toContain('raise');
    Object.assign(state, { ...menu, bettingStructure: menu.structure });
    seedFastRandom(1);
    const decision = HorseLogic.decide(
      hero,
      state,
      'balanced',
      {},
      { mind: false, v9Timing: false }
    );
    expect(decision.action).toBe('raise');
    expect(controller.performAction(hero.seat, decision.action, decision.amount)).toBe(true);
    expect(controller.getState().currentBet).toBe(decision.amount);
  });
  it('regresses hand 44826179 across every style and RNG seed', () => {
    for (const style of ['balanced', 'tag', 'lag', 'tricky', 'grinder'] as const) {
      for (let seed = 1; seed <= 12; seed++) {
        seedFastRandom(seed);
        const { hero, state } = incident();
        const d = HorseLogic.decide(
          hero,
          state,
          style,
          {},
          {
            mind: false,
            phase11Omaha: 'off',
            phase13Joint: 'off',
            v9Timing: false,
          }
        );
        expect(d.action, `${style} seed ${seed}`).toBe('raise');
        expect(d.amount).toBeGreaterThanOrEqual(100);
        expect(d.amount).toBeLessThanOrEqual(269);
      }
    }
  });

  it.each([
    'nlh',
    'flh',
    'pineapple',
    'short_deck',
    'plo4',
    'plo5',
    'plo6',
    'plo8',
    'flo8',
  ] as const)(
    '%s raises after all policy owners, including fixed-limit and split-pot rules',
    (variant) => {
      const { hero, state } = incident(variant);
      if (['nlh', 'flh', 'pineapple'].includes(variant)) hero.cards = cards('7c 5d');
      if (variant === 'short_deck') {
        hero.cards = cards('Ac Kd');
        state.communityCards = cards('Qh Js Td 6c 7d');
      }
      if (variant === 'plo8' || variant === 'flo8') {
        hero.cards = cards('6c 7d Ac 2h');
        state.communityCards = cards('3c 4d 5h 9s Kd');
      }
      if (variant === 'flh' || variant === 'flo8') {
        Object.assign(state, { fixedBetSize: 4, minRaiseTo: 54, maxRaiseTo: 54 });
      }
      for (let seed = 1; seed <= 6; seed++) {
        seedFastRandom(seed);
        const d = HorseLogic.decide(hero, state, 'balanced', {}, { mind: false, v9Timing: false });
        expect(d.policyFallback).toBeUndefined();
        expect(d.action).toBe('raise');
        expect(d.amount).toBeGreaterThanOrEqual(state.minRaiseTo!);
        expect(d.amount).toBeLessThanOrEqual(state.maxRaiseTo!);
        expect(d.policyGraph?.transitions.at(-2)?.node).toBe('wager_rules');
        expect(d.policyGraph?.finalAction).toEqual({ action: 'raise', amount: d.amount });
      }
    }
  );

  it('recognizes closing action out of position instead of requiring the button', () => {
    const { hero, state } = incident();
    state.dealerSeat = 2;
    expect(riverNutsRaise({ action: 'call', amount: 50, thinkTime: 0 }, hero, state).action).toBe(
      'raise'
    );
  });

  it.each(['reopening', 'cap', 'call_all_in', 'opponents_all_in', 'turn'] as const)(
    'does not manufacture a raise with %s',
    (boundary) => {
      const { hero, state } = incident();
      if (boundary === 'reopening' || boundary === 'cap') state.legalActions = ['fold', 'call'];
      if (boundary === 'cap') state.wagersCapped = true;
      if (boundary === 'call_all_in') hero.stack = 50;
      if (boundary === 'opponents_all_in') state.players[1].is_all_in = true;
      if (boundary === 'turn') {
        state.stage = 'turn';
        state.communityCards.pop();
      }
      const call = { action: 'call' as const, amount: 50, thinkTime: 0 };
      expect(riverNutsRaise(call, hero, state)).toBe(call);
    }
  );

  it('takes a legal short all-in raise even below the full raise floor', () => {
    const { hero, state } = incident();
    hero.stack = 75;
    Object.assign(state, {
      legalActions: ['fold', 'call', 'all_in'],
      minRaiseTo: null,
      maxRaiseTo: null,
    });
    expect(riverNutsRaise({ action: 'call', amount: 50, thinkTime: 7 }, hero, state)).toMatchObject(
      { action: 'all_in', thinkTime: 7 }
    );
  });

  it('does not confuse a fixed-limit all-in button that only calls with a legal raise', () => {
    const { hero, state } = incident('flh');
    hero.cards = cards('7c 5d');
    Object.assign(state, {
      fixedBetSize: 4,
      legalActions: ['fold', 'call', 'all_in'],
      minRaiseTo: null,
      maxRaiseTo: null,
      wagersCapped: true,
    });
    const call = { action: 'call' as const, amount: 50, thinkTime: 0 };
    expect(riverNutsRaise(call, hero, state)).toBe(call);
    state.wagersCapped = false; // the same menu when action was not reopened
    expect(riverNutsRaise(call, hero, state)).toBe(call);
  });

  it('still takes a real fixed-limit short all-in raise with null normal bounds', () => {
    const { hero, state } = incident('flh');
    hero.cards = cards('7c 5d');
    hero.stack = 52;
    Object.assign(state, {
      fixedBetSize: 4,
      legalActions: ['fold', 'call', 'all_in'],
      minRaiseTo: null,
      maxRaiseTo: null,
    });
    expect(riverNutsRaise({ action: 'call', amount: 50, thinkTime: 0 }, hero, state).action).toBe(
      'all_in'
    );
  });

  it('sizes an under-sized pot-limit nut raise up to the maximum (hand 45000112)', () => {
    const { hero, state } = incident();
    const raise = { action: 'raise' as const, amount: 125, thinkTime: 17 };
    expect(riverNutsRaise(raise, hero, state)).toMatchObject({
      action: 'raise',
      amount: 269,
      thinkTime: 17,
    });
    const max = { action: 'raise' as const, amount: 269, thinkTime: 17 };
    expect(riverNutsRaise(max, hero, state)).toBe(max);
  });

  it.each(['flush', 'paired', 'wrong_two_hole', 'nut_low_only', 'high_only_low_live'] as const)(
    'does not mistake %s for the entire-pot nuts',
    (trap) => {
      const { hero, state } = incident();
      if (trap === 'flush') state.communityCards = cards('2s 3s 6s Jh 4d');
      if (trap === 'paired') state.communityCards = cards('2d 3s 6s 3h 4d');
      if (trap === 'wrong_two_hole') {
        hero.cards = cards('7c Ac Kh Qh Td');
      }
      if (trap === 'nut_low_only') {
        state.gameVariant = 'plo8';
        hero.cards = cards('Ac 2h Qc Td');
        state.communityCards = cards('3c 4d 5h 9s Kd');
      }
      if (trap === 'high_only_low_live') {
        state.gameVariant = 'plo8';
        hero.cards = cards('6c 7d Qc Td');
        state.communityCards = cards('3c 4d 5h 9s Kd');
      }
      expect(hasRiverNuts(hero, state)).toBe(false);
    }
  );

  it('honors Short Deck flush-over-full-house ordering', () => {
    const { hero, state } = incident('short_deck');
    hero.cards = cards('Ah Ac');
    state.communityCards = cards('As Kh Kd 7s 9s');
    expect(hasRiverNuts(hero, state)).toBe(false); // a spade flush beats aces full
  });

  it('requires the nuts on every board, and accepts two-board nuts', () => {
    const { hero, state } = incident('plo4');
    hero.cards = cards('7c 5d Ah Kh');
    state.boardCount = 2;
    state.communityCards2 = cards('Qh Jh Th 8c 9d');
    expect(hasRiverNuts(hero, state)).toBe(true);
    state.communityCards2 = cards('Qc Jd Ts 8c 8d');
    expect(hasRiverNuts(hero, state)).toBe(false);
  });

  it('handles a board-only shared nuts hand without misreading it as a weaker holding', () => {
    const { hero, state } = incident('nlh');
    hero.cards = cards('2c 3c');
    state.communityCards = cards('As Ks Qs Js Ts');
    expect(hasRiverNuts(hero, state)).toBe(true);
  });

  it('does not read opponents private cards to decide whether hero has the nuts', () => {
    const { hero, state } = incident();
    state.players[1].cards = cards('Ac Ad Ah As Kc');
    expect(hasRiverNuts(hero, state)).toBe(true);
  });

  it('refuses incomplete or duplicate-card inputs', () => {
    const { hero, state } = incident();
    state.communityCards[0] = hero.cards[0];
    expect(hasRiverNuts(hero, state)).toBe(false);
    state.communityCards.pop();
    expect(hasRiverNuts(hero, state)).toBe(false);
  });
});

describe('near-pot wagers use full pot when the authoritative menu allows it', () => {
  it('keeps a fractional full pot unchanged through the canonical legalizer', () => {
    const { hero, state } = incident();
    Object.assign(state, {
      stage: 'flop',
      pot: 100.37,
      currentBet: 0,
      toCall: 0,
      minRaise: 2,
      minRaiseTo: 2,
      maxRaiseTo: 100.37,
      legalActions: ['check', 'bet'],
    });
    const wager = { action: 'bet' as const, amount: 100.37, thinkTime: 0 };
    const legalize = (HorseLogic as any).legalize.bind(HorseLogic);
    const legal = legalize(wager, hero, state, variantInfo('plo5'));
    expect(legal).toMatchObject({ action: 'bet', amount: 100.37 });
    expect(legalize(legal, hero, state, variantInfo('plo5'))).toEqual(legal);
  });

  it.each([90, 95.88, 99.99, 100])('rounds a %s percent bet to full pot', (amount) => {
    const { hero, state } = incident();
    Object.assign(state, {
      stage: 'flop',
      pot: 100,
      currentBet: 0,
      toCall: 0,
      minRaiseTo: 2,
      maxRaiseTo: 100,
      legalActions: ['check', 'bet'],
    });
    expect(fullPotNearPotWager({ action: 'bet', amount, thinkTime: 7 }, hero, state)).toMatchObject(
      { action: 'bet', amount: 100, thinkTime: 7 }
    );
  });
  it.each([89.99, 101, 150])('preserves other sizing %s', (amount) => {
    const { hero, state } = incident();
    Object.assign(state, {
      pot: 100,
      currentBet: 0,
      toCall: 0,
      minRaiseTo: 2,
      maxRaiseTo: 500,
      legalActions: ['bet'],
    });
    const wager = { action: 'bet' as const, amount, thinkTime: 0 };
    expect(fullPotNearPotWager(wager, hero, state)).toBe(wager);
  });
  it('prices a pot raise after calling, including already committed chips', () => {
    const { hero, state } = incident();
    const wager = { action: 'raise' as const, amount: 248, thinkTime: 0 };
    expect(fullPotNearPotWager(wager, hero, state).amount).toBe(269);
  });
  it.each(['stack', 'cap', 'fixed', 'menu'] as const)(
    'preserves a wager when full pot is illegal: %s',
    (why) => {
      const { hero, state } = incident();
      Object.assign(state, {
        pot: 100,
        currentBet: 0,
        toCall: 0,
        minRaiseTo: 2,
        maxRaiseTo: 100,
        legalActions: ['bet'],
      });
      if (why === 'stack') hero.stack = 95;
      if (why === 'cap') state.maxRaiseTo = 95;
      if (why === 'fixed') {
        state.gameVariant = 'flh';
        state.bettingStructure = 'fixed_limit';
      }
      if (why === 'menu') state.legalActions = ['check'];
      const wager = { action: 'bet' as const, amount: 90, thinkTime: 0 };
      expect(fullPotNearPotWager(wager, hero, state)).toBe(wager);
    }
  );
});

describe('multiway nut-flush incident 44867615', () => {
  it('raises the nut flush even with a third responder behind', () => {
    const { hero, state } = incident();
    hero.cards = cards('As 5s Kc Jd Th');
    hero.stack = 800;
    state.communityCards = cards('4s 2s Qs 7c 8h');
    state.players[1].bet = 163;
    state.players[2] = {
      ...state.players[2],
      is_folded: false,
      is_all_in: false,
      bet: 0,
      stack: 355.85,
    };
    Object.assign(state, {
      pot: 333,
      currentBet: 163,
      toCall: 163,
      minRaiseTo: 326,
      maxRaiseTo: 659,
    });
    expect(
      riverNutsRaise({ action: 'call', amount: 163, thinkTime: 0 }, hero, state)
    ).toMatchObject({ action: 'raise', amount: 659 });
  });
});

function checkedTo(variant: GameVariant = 'plo5') {
  const { hero, state } = incident(variant);
  state.players[1] = { ...state.players[1], bet: 0 };
  Object.assign(state, {
    pot: 169,
    currentBet: 0,
    toCall: 0,
    minRaiseTo: 2,
    maxRaiseTo: 169,
    legalActions: ['fold', 'check', 'bet', 'all_in'],
  });
  return { hero, state };
}

describe('the river nuts always bet when checked to and are never under-sized', () => {
  const check = { action: 'check' as const, thinkTime: 3 };

  it('turns a checked-to nut check into a full pot-limit bet', () => {
    const { hero, state } = checkedTo();
    expect(riverNutsRaise(check, hero, state)).toMatchObject({
      action: 'bet',
      amount: 169,
      thinkTime: 3,
    });
  });

  it('sizes an under-sized nut bet up and keeps a full one', () => {
    const { hero, state } = checkedTo();
    expect(riverNutsRaise({ action: 'bet', amount: 60, thinkTime: 0 }, hero, state)).toMatchObject({
      action: 'bet',
      amount: 169,
    });
    const full = { action: 'bet' as const, amount: 169, thinkTime: 0 };
    expect(riverNutsRaise(full, hero, state)).toBe(full);
  });

  it('bets at least the full pot in no limit and keeps a larger policy size', () => {
    const { hero, state } = checkedTo('nlh');
    hero.cards = cards('7c 5d');
    Object.assign(state, { bettingStructure: 'no_limit', maxRaiseTo: 275.5 });
    expect(riverNutsRaise(check, hero, state)).toMatchObject({ action: 'bet', amount: 169 });
    const shove = { action: 'bet' as const, amount: 275.5, thinkTime: 0 };
    expect(riverNutsRaise(shove, hero, state)).toBe(shove);
    const facing = incident('nlh');
    facing.hero.cards = cards('7c 5d');
    Object.assign(facing.state, { bettingStructure: 'no_limit', maxRaiseTo: 275.5 });
    expect(
      riverNutsRaise({ action: 'raise', amount: 120, thinkTime: 0 }, facing.hero, facing.state)
    ).toMatchObject({ action: 'raise', amount: 269 });
  });

  it('bets the fixed-limit size when checked to', () => {
    const { hero, state } = checkedTo('flh');
    hero.cards = cards('7c 5d');
    Object.assign(state, { fixedBetSize: 4, minRaiseTo: 4, maxRaiseTo: 4 });
    expect(riverNutsRaise(check, hero, state)).toMatchObject({ action: 'bet', amount: 4 });
  });

  it.each(['not_nuts', 'no_bet_menu', 'opponents_all_in', 'turn', 'stack_cap', 'capped'] as const)(
    'keeps the check with %s',
    (boundary) => {
      const { hero, state } = checkedTo();
      if (boundary === 'not_nuts') state.communityCards = cards('2s 3s 6s Jh 4d');
      if (boundary === 'no_bet_menu') state.legalActions = ['fold', 'check'];
      if (boundary === 'opponents_all_in') state.players[1].is_all_in = true;
      if (boundary === 'turn') {
        state.stage = 'turn';
        state.communityCards.pop();
      }
      if (boundary === 'stack_cap') state.maxRaiseTo = 400; // menu above hero's chips
      if (boundary === 'capped') state.wagersCapped = true;
      expect(riverNutsRaise(check, hero, state)).toBe(check);
    }
  );

  it('never checks the river nuts through HorseLogic in any style or seed', () => {
    for (const style of ['balanced', 'tag', 'lag', 'tricky', 'grinder'] as const) {
      for (let seed = 1; seed <= 8; seed++) {
        seedFastRandom(seed);
        const { hero, state } = checkedTo();
        const d = HorseLogic.decide(
          hero,
          state,
          style,
          {},
          { mind: false, phase11Omaha: 'off', phase13Joint: 'off', v9Timing: false }
        );
        expect(d.action, `${style} seed ${seed}`).toBe('bet');
        expect(d.amount, `${style} seed ${seed}`).toBe(169);
        expect(d.policyGraph?.finalAction).toEqual({ action: 'bet', amount: 169 });
      }
    }
  });

  it.each(['nlh', 'short_deck', 'plo4', 'plo6', 'plo8'] as const)(
    '%s bets the nuts when checked to after every policy owner',
    (variant) => {
      const { hero, state } = checkedTo(variant);
      if (variant === 'nlh') {
        hero.cards = cards('7c 5d');
        state.bettingStructure = 'no_limit';
      }
      if (variant === 'short_deck') {
        hero.cards = cards('Ac Kd');
        state.communityCards = cards('Qh Js Td 6c 7d');
      }
      if (variant === 'plo8') {
        hero.cards = cards('6c 7d Ac 2h');
        state.communityCards = cards('3c 4d 5h 9s Kd');
      }
      for (let seed = 1; seed <= 4; seed++) {
        seedFastRandom(seed);
        const d = HorseLogic.decide(hero, state, 'balanced', {}, { mind: false, v9Timing: false });
        expect(d.policyFallback).toBeUndefined();
        expect(d.action, `${variant} seed ${seed}`).toBe('bet');
        expect(d.amount).toBeGreaterThanOrEqual(state.minRaiseTo!);
        expect(d.amount).toBeLessThanOrEqual(state.maxRaiseTo!);
      }
    }
  );
});

describe('checked-to near-nut full house value', () => {
  it.each([
    'nlh',
    'flh',
    'pineapple',
    'short_deck',
    'plo4',
    'plo5',
    'plo6',
    'plo8',
    'flo8',
  ] as const)('%s never checks back AQ on QQ75A', (variant) => {
    for (const style of ['balanced', 'tag', 'lag', 'tricky', 'grinder'] as const) {
      for (let seed = 1; seed <= 12; seed++) {
        const { hero, state } = checkedTo(variant);
        hero.cards = cards(
          variant === 'plo6'
            ? 'Ac Qd Kc Jh 9s 8h'
            : variant === 'plo5'
              ? 'Ac Qd Kc Jh 9s'
              : variant.startsWith('plo') || variant === 'flo8'
                ? 'Ac Qd Kc Jh'
                : 'Ac Qd'
        );
        state.communityCards = cards(
          variant === 'short_deck' ? 'Qh Qs 7c 9d Ah' : 'Qh Qs 7c 5d Ah'
        );
        state.dealerSeat = hero.seat;
        state.actionHistory = [
          {
            userId: state.players[1].user_id,
            seat: state.players[1].seat,
            action: 'bet',
            amount: 30,
            stage: 'turn',
            timestamp: 1,
          },
          {
            userId: hero.user_id,
            seat: hero.seat,
            action: 'call',
            amount: 30,
            stage: 'turn',
            timestamp: 2,
          },
          {
            userId: state.players[1].user_id,
            seat: state.players[1].seat,
            action: 'check',
            amount: 0,
            stage: 'river',
            timestamp: 3,
          },
        ];
        if (variant === 'flh' || variant === 'flo8')
          Object.assign(state, { fixedBetSize: 4, minRaiseTo: 4, maxRaiseTo: 4 });
        seedFastRandom(seed);
        const d = HorseLogic.decide(hero, state, style, {}, { v9Timing: false });
        expect(d.action, `${variant} ${style} seed ${seed}`).toBe('bet');
        expect(d.amount).toBeGreaterThan(0);
      }
    }
  });
});
