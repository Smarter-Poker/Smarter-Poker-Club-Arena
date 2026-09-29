/**
 * KILL POTS, rule manifest kill-v1: the kill hand as HandController plays it.
 *
 * The table posts blinds 2/4, so its base game is 4/8 limit. A FULL kill plays
 * 8/16 with an 8 kill blind; a HALF kill plays 6/12 with a 6 kill blind. The
 * ordinary blinds stay 2/4 on every hand.
 *
 * Cards are crypto-random, so every assertion is on posting, sizing, order and
 * chip math, never on who wins.
 */
import { describe, it, expect } from 'vitest';
import { HandController } from './HandController.js';
import { KILL_RULE_VERSION, killStakes, type KillHandState } from './KillPot.js';
import type { HandConfig, SeatPlayer, HandEvent } from '../types.js';

function players(stacks: number[]): SeatPlayer[] {
  return stacks.map(
    (stack, i) =>
      ({
        seat: i + 1,
        user_id: `u${i + 1}`,
        username: `P${i + 1}`,
        stack,
        bet: 0,
        totalInvested: 0,
        cards: [],
        is_folded: false,
        is_all_in: false,
        is_sitting_out: false,
      }) as SeatPlayer
  );
}

function kill(mode: 'half' | 'full', killerSeat: number, over: Partial<KillHandState> = {}) {
  const s = killStakes({ baseBigBlind: 4, mode });
  if (!s.ok) throw new Error(s.reason);
  return {
    ruleVersion: KILL_RULE_VERSION,
    mode: s.mode,
    multiplier: s.multiplier,
    baseBigBlind: 4,
    smallBet: s.smallBet,
    bigBet: s.bigBet,
    killBlind: s.killBlind,
    killerUserId: `u${killerSeat}`,
    killerSeat,
    killerBlindSlot: 'none',
    triggerHandId: 'trigger-row',
    triggerHandNumber: 1,
    chained: false,
    thresholdBb: 10,
    ...over,
  } as KillHandState;
}

function config(over: Partial<HandConfig> = {}): HandConfig {
  return {
    tableId: 't-kill',
    handNumber: 2,
    gameVariant: 'flh',
    smallBlind: 2,
    bigBlind: 4,
    rakeConfig: { percent: 5, cap: 1, noFlopNoDrop: true },
    ...over,
  } as HandConfig;
}

function harness(cfg: HandConfig, stacks: number[], dealerSeat = 1) {
  const hc = new HandController(cfg, players(stacks), dealerSeat);
  const events: HandEvent[] = [];
  hc.onEvent((e) => events.push(e));
  const startChips = stacks.reduce((a, b) => a + b, 0);
  hc.start();
  const st = () => (hc as unknown as { state: any }).state;
  const seat = (n: number): SeatPlayer => st().players.find((p: SeatPlayer) => p.seat === n);
  return {
    hc,
    events,
    st,
    seat,
    cur: () => st().currentPlayerSeat as number,
    act: (action: string, amount?: number) =>
      hc.performAction(st().currentPlayerSeat, action as any, amount),
    auth: () => hc.getAuthoritativeActionState(seat(st().currentPlayerSeat).user_id)!,
    chips: () =>
      Math.round(
        (st().players.reduce((s: number, p: SeatPlayer) => s + p.stack, 0) + st().pot) * 100
      ) / 100,
    startChips,
    blindsPosted: () =>
      (events.find((e) => e.type === ('BLINDS_POSTED' as never)) as any)?.postings ?? [],
    forced: () => (events.find((e) => e.type === 'FORCED_BETS_POSTED') as any)?.postings ?? [],
  };
}

const SIX = [400, 400, 400, 400, 400];

describe('off: a hand without a kill is exactly the base game', () => {
  it('4/8 limit, the big blind is the bet, no kill blind anywhere', () => {
    const h = harness(config(), SIX);
    expect(h.st().currentBet).toBe(4);
    expect(h.auth().fixedBetSize).toBe(4);
    expect(h.auth().minRaiseTo).toBe(8);
    expect(h.blindsPosted().map((p: any) => p.type)).toEqual(['small_blind', 'big_blind']);
    expect(h.hc.getKillHandState()).toBeNull();
    expect(h.hc.getFixedLimitSmallBet()).toBe(4);
  });
});

describe('full kill: the killer posts a live 8 and the hand plays 8/16', () => {
  it('killer UTG: posts after the blinds, is the bet level, and acts first with the option', () => {
    // Dealer 1, SB 2, BB 3, UTG 4 (the killer).
    const h = harness(config({ killPot: kill('full', 4) }), SIX);
    expect(h.seat(2).bet).toBe(2);
    expect(h.seat(3).bet).toBe(4);
    expect(h.seat(4).bet).toBe(8);
    expect(h.seat(4).stack).toBe(392);
    expect(h.st().pot).toBe(14);
    expect(h.st().currentBet).toBe(8);
    // Ordinary clockwise order: first to act is left of the big blind - the killer.
    expect(h.cur()).toBe(4);
    const a = h.auth();
    expect(a.toCall).toBe(0);
    expect(a.legalActions).toEqual(expect.arrayContaining(['check', 'raise']));
    expect(a.fixedBetSize).toBe(8);
    expect(a.minRaiseTo).toBe(16);
    expect(a.maxRaiseTo).toBe(16);
    // The post is on the record as a live kill blind, and animates as one.
    expect(h.blindsPosted()).toEqual([
      { seat: 2, type: 'small_blind', amount: 2 },
      { seat: 3, type: 'big_blind', amount: 4 },
      { seat: 4, type: 'kill_blind', amount: 8 },
    ]);
    expect(h.forced()).toEqual(
      expect.arrayContaining([
        { seat: 4, userId: 'u4', kind: 'kill_blind', amount: 8, dead: false },
        { seat: 2, userId: 'u2', kind: 'sb', amount: 2, dead: false },
        { seat: 3, userId: 'u3', kind: 'bb', amount: 4, dead: false },
      ])
    );
    expect(h.chips()).toBe(h.startChips);
  });

  it('the kill blind is the first preflop wager: three raises cap the street', () => {
    const h = harness(config({ killPot: kill('full', 4) }), SIX);
    expect(h.act('raise', 16)).toBe(true); // killer: 2nd wager
    expect(h.act('raise', 24)).toBe(true); // seat 5: 3rd wager
    expect(h.auth().legalActions).toContain('raise');
    expect(h.act('raise', 32)).toBe(true); // seat 1: 4th wager - capped
    const a = h.auth();
    expect(a.wagersCapped).toBe(true);
    expect(a.legalActions).not.toContain('raise');
    expect(a.toCall).toBe(30); // SB has 2 in
  });

  it('every street is sized from the kill: 8 on the flop, 16 on the turn and river', () => {
    const h = harness(config({ killPot: kill('full', 4) }), SIX);
    // Preflop: killer checks its option, the other four (blinds included) call 8.
    expect(h.act('check')).toBe(true);
    for (let i = 0; i < 4; i++) expect(h.act('call')).toBe(true);
    expect(h.st().stage).toBe('flop');
    expect(h.auth().fixedBetSize).toBe(8);
    expect(h.act('bet', 8)).toBe(true);
    expect(h.auth().minRaiseTo).toBe(16);
    for (let i = 0; i < 4; i++) expect(h.act('call')).toBe(true);
    expect(h.st().stage).toBe('turn');
    expect(h.auth().fixedBetSize).toBe(16);
    expect(h.act('bet', 16)).toBe(true);
    expect(h.auth().minRaiseTo).toBe(32);
    expect(h.chips()).toBe(h.startChips);
  });

  it('a wager sized for the base game is refused on a kill hand', () => {
    const h = harness(config({ killPot: kill('full', 4) }), SIX);
    expect(h.act('raise', 12)).toBe(false); // base sizing: 8 + 4
    expect(h.act('raise', 16)).toBe(true);
  });

  it('a short all-in reopens at half the KILL street bet, not half the base one', () => {
    // Seat 5 holds 11: facing 8, an all-in to 11 is a 3 raise - below half of 8,
    // so it does not reopen for the killer who already acted.
    const h = harness(config({ killPot: kill('full', 4) }), [400, 400, 400, 400, 11]);
    expect(h.act('check')).toBe(true); // killer's option
    expect(h.act('all_in')).toBe(true); // seat 5 to 11
    expect(h.act('call')).toBe(true); // seat 1
    expect(h.act('call')).toBe(true); // seat 2
    expect(h.act('call')).toBe(true); // seat 3
    expect(h.cur()).toBe(4);
    expect(h.auth().legalActions).not.toContain('raise');
  });
});

describe('half kill: 6/12 with a 6 kill blind', () => {
  it('posts 6 and sizes 6 preflop and on the flop, 12 on the turn', () => {
    const h = harness(config({ killPot: kill('half', 4) }), SIX);
    expect(h.seat(4).bet).toBe(6);
    expect(h.st().currentBet).toBe(6);
    expect(h.auth().fixedBetSize).toBe(6);
    expect(h.auth().minRaiseTo).toBe(12);
    expect(h.act('check')).toBe(true);
    for (let i = 0; i < 4; i++) expect(h.act('call')).toBe(true);
    expect(h.st().stage).toBe('flop');
    expect(h.auth().fixedBetSize).toBe(6);
    for (let i = 0; i < 5; i++) expect(h.act('check')).toBe(true);
    expect(h.st().stage).toBe('turn');
    expect(h.auth().fixedBetSize).toBe(12);
    expect(h.chips()).toBe(h.startChips);
  });
});

describe('where the killer sits', () => {
  it('killer in the small blind posts ONLY the kill blind; the big blind posts normally', () => {
    const h = harness(config({ killPot: kill('full', 2, { killerBlindSlot: 'sb' }) }), SIX);
    expect(h.seat(2).bet).toBe(8);
    expect(h.seat(2).totalInvested).toBe(8);
    expect(h.seat(2).stack).toBe(392);
    expect(h.seat(3).bet).toBe(4);
    expect(h.st().pot).toBe(12);
    expect(h.blindsPosted()).toEqual([
      { seat: 3, type: 'big_blind', amount: 4 },
      { seat: 2, type: 'kill_blind', amount: 8 },
    ]);
    expect(h.forced().filter((p: any) => p.seat === 2)).toEqual([
      { seat: 2, userId: 'u2', kind: 'kill_blind', amount: 8, dead: false },
    ]);
    expect(h.cur()).toBe(4); // UTG faces 8
    expect(h.auth().toCall).toBe(8);
  });

  it('killer in the big blind posts ONLY the kill blind; the small blind posts normally', () => {
    const h = harness(config({ killPot: kill('full', 3, { killerBlindSlot: 'bb' }) }), SIX);
    expect(h.seat(2).bet).toBe(2);
    expect(h.seat(3).bet).toBe(8);
    expect(h.seat(3).totalInvested).toBe(8);
    expect(h.st().pot).toBe(10);
    expect(h.st().currentBet).toBe(8);
    expect(h.forced().filter((p: any) => p.seat === 3)).toEqual([
      { seat: 3, userId: 'u3', kind: 'kill_blind', amount: 8, dead: false },
    ]);
    expect(h.cur()).toBe(4);
  });

  it('killer on the button: acts in turn after UTG, with the option if unraised', () => {
    const h = harness(config({ killPot: kill('full', 1) }), SIX);
    expect(h.seat(1).bet).toBe(8);
    expect(h.cur()).toBe(4);
    expect(h.act('call')).toBe(true); // UTG calls the kill
    expect(h.act('call')).toBe(true); // seat 5
    expect(h.cur()).toBe(1);
    const a = h.auth();
    expect(a.toCall).toBe(0);
    expect(a.legalActions).toEqual(expect.arrayContaining(['check', 'raise']));
  });

  it('heads-up, killer on the button (small blind): kill only, acts first with the option', () => {
    const h = harness(config({ killPot: kill('full', 1, { killerBlindSlot: 'sb' }) }), [400, 400]);
    expect(h.seat(1).bet).toBe(8);
    expect(h.seat(2).bet).toBe(4);
    expect(h.st().pot).toBe(12);
    expect(h.cur()).toBe(1);
    expect(h.auth().toCall).toBe(0);
    expect(h.act('check')).toBe(true);
    // The big blind still owes 4 and may call or raise.
    expect(h.cur()).toBe(2);
    expect(h.auth().toCall).toBe(4);
    expect(h.act('call')).toBe(true);
    expect(h.st().stage).toBe('flop');
    expect(h.chips()).toBe(h.startChips);
  });

  it('heads-up, killer in the big blind: the button posts 2 and faces the kill', () => {
    const h = harness(config({ killPot: kill('full', 2, { killerBlindSlot: 'bb' }) }), [400, 400]);
    expect(h.seat(1).bet).toBe(2);
    expect(h.seat(2).bet).toBe(8);
    expect(h.cur()).toBe(1);
    expect(h.auth().toCall).toBe(6);
    expect(h.act('call')).toBe(true);
    // Unraised: the killer keeps the option.
    expect(h.cur()).toBe(2);
    expect(h.auth().legalActions).toEqual(expect.arrayContaining(['check', 'raise']));
  });
});

describe('the short killer', () => {
  it('posts all in for the stack; the level stays the full kill blind and nothing is made', () => {
    const h = harness(config({ killPot: kill('full', 4) }), [400, 400, 400, 5, 400]);
    expect(h.seat(4).bet).toBe(5);
    expect(h.seat(4).is_all_in).toBe(true);
    expect(h.st().currentBet).toBe(8);
    expect(h.blindsPosted().find((p: any) => p.seat === 4)).toEqual({
      seat: 4,
      type: 'kill_blind',
      amount: 5,
    });
    // The all-in killer cannot act; UTG+1 faces the full kill blind.
    expect(h.cur()).toBe(5);
    expect(h.auth().toCall).toBe(8);
    expect(h.auth().fixedBetSize).toBe(8);
    for (let i = 0; i < 4; i++) expect(h.act('call')).toBe(true);
    expect(h.st().stage).toBe('flop');
    // Still kill limits after the killer is all in.
    expect(h.auth().fixedBetSize).toBe(8);
    expect(h.chips()).toBe(h.startChips);
  });

  it('plays to completion with side pots and conserves every chip', () => {
    const h = harness(config({ killPot: kill('full', 4) }), [400, 400, 400, 5, 400]);
    let guard = 0;
    while (!h.events.some((e) => e.type === 'HAND_COMPLETE') && guard++ < 200) {
      const menu = h.auth().legalActions;
      if (h.events.some((e) => e.type === ('ALL_IN_RUNOUT' as never))) {
        h.hc.continueRunout();
        continue;
      }
      h.act(menu.includes('check') ? 'check' : 'call');
    }
    const done = h.events.find((e) => e.type === 'HAND_COMPLETE') as any;
    expect(done).toBeTruthy();
    const stacks = h.st().players.reduce((s: number, p: SeatPlayer) => s + p.stack, 0);
    expect(Math.round((stacks + done.rake + done.bbjFee) * 100) / 100).toBe(h.startChips);
  });
});

describe("the kill does not touch anyone else's forced money", () => {
  it('a new player posting a big blind to enter posts 4 live, and faces the kill', () => {
    const h = harness(config({ killPot: kill('full', 1), bbOnlyPosts: [{ seat: 5 }] }), SIX);
    expect(h.seat(5).bet).toBe(4);
    expect(h.seat(1).bet).toBe(8);
    expect(h.st().currentBet).toBe(8);
    expect(h.forced().filter((p: any) => p.seat === 5)).toEqual([
      { seat: 5, userId: 'u5', kind: 'post', amount: 4, dead: false },
    ]);
  });

  it('a player back from sit-out posts the dead small blind and a live big blind as usual', () => {
    const h = harness(config({ killPot: kill('full', 1), deadBlinds: [{ seat: 5 }] }), SIX);
    expect(h.seat(5).bet).toBe(4);
    expect(h.seat(5).totalInvested).toBe(6);
    expect(h.forced().filter((p: any) => p.seat === 5)).toEqual(
      expect.arrayContaining([
        { seat: 5, userId: 'u5', kind: 'post', amount: 4, dead: false },
        { seat: 5, userId: 'u5', kind: 'post', amount: 2, dead: true },
      ])
    );
  });

  it('antes are posted before the kill and are unchanged by it', () => {
    const h = harness(config({ killPot: kill('full', 4), ante: 1 }), SIX);
    expect(h.st().pot).toBe(14 + 5);
    expect(h.seat(4).totalInvested).toBe(9);
    expect(h.seat(4).bet).toBe(8);
  });
});

describe('base stakes for every deduction (non-regression)', () => {
  it('the rake cap is the configured base cap, not scaled by the kill', () => {
    const h = harness(config({ killPot: kill('full', 4) }), SIX);
    // Big pot: 5% of it would be far above the 1.00 cap.
    expect(h.act('raise', 16)).toBe(true);
    for (let i = 0; i < 4; i++) h.act('call');
    const { rake } = h.hc.computeRakeAndBBJ(true);
    expect(h.st().pot).toBeGreaterThan(40);
    expect(rake).toBe(1);
  });

  it('the BBJ fee is base big blind x feeBB, identical on a kill hand and a base hand', () => {
    const bbj = { enabled: true, feeBB: 0.25, minPotBB: 0, minPlayersDealt: 2 };
    const killHand = harness(config({ killPot: kill('full', 4), bbjConfig: bbj }), SIX);
    const baseHand = harness(config({ bbjConfig: bbj }), SIX);
    expect(killHand.hc.computeRakeAndBBJ(true).bbjFee).toBe(1);
    expect(baseHand.hc.computeRakeAndBBJ(true).bbjFee).toBe(1);
  });

  it('the dealt blinds the rest of the engine reads stay the base blinds', () => {
    const h = harness(config({ killPot: kill('full', 4) }), SIX);
    expect(h.hc.getBlindSnapshot()).toMatchObject({ smallBlind: 2, bigBlind: 4 });
  });

  it('the kill blind is an ordinary contribution: weighted rake counts it like any other', () => {
    const h = harness(config({ killPot: kill('full', 4) }), SIX);
    expect(h.seat(4).totalInvested).toBe(8);
    expect(h.seat(4).deadInvested ?? 0).toBe(0);
  });
});

describe('a kill the controller cannot honour is dropped before anything sizes from it', () => {
  it('killer not in the dealt roster: a base-limit hand', () => {
    const h = harness(config({ killPot: kill('full', 9) }), SIX);
    expect(h.hc.getKillHandState()).toBeNull();
    expect(h.st().currentBet).toBe(4);
    expect(h.auth().fixedBetSize).toBe(4);
  });

  it('a kill on a no-limit hand: dropped', () => {
    const h = harness(config({ gameVariant: 'nlh', killPot: kill('full', 4) }), SIX);
    expect(h.hc.getKillHandState()).toBeNull();
    expect(h.seat(4).bet).toBe(0);
    expect(h.hc.getFixedLimitSmallBet()).toBeNull();
  });
});

describe('fixed-limit Omaha Hi-Lo plays the kill identically', () => {
  it('flo8: 8/16, kill blind 8, killer UTG with the option', () => {
    const h = harness(config({ gameVariant: 'flo8', killPot: kill('full', 4) }), SIX);
    expect(h.seat(4).bet).toBe(8);
    expect(h.auth().fixedBetSize).toBe(8);
    expect(h.auth().legalActions).toEqual(expect.arrayContaining(['check', 'raise']));
  });
});
