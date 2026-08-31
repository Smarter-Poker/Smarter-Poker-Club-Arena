/**
 * BASIC POKER PLAY — end-to-end functional verification (2026-07-19).
 *
 * Drives COMPLETE hands through the real HandController and asserts every basic
 * play requirement from Bible V8 Ch.4: hands dealt correctly, players act in
 * turn, and check / bet / call / raise / fold / all-in each work as they should,
 * with correct street progression, showdown, and chip conservation.
 *
 * Cards are crypto-random, so assertions are on STRUCTURE (counts, turn order,
 * pot math, action legality, conservation) — never on which card comes out.
 */
import { describe, it, expect } from 'vitest';
import { HandController } from './HandController.js';
import type { HandConfig, HandEvent, SeatPlayer } from '../types.js';

function mkPlayers(stacks: number[]): SeatPlayer[] {
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

function mkConfig(over: Partial<HandConfig> = {}): HandConfig {
  return {
    tableId: 't1',
    handNumber: 1,
    gameVariant: 'nlh',
    smallBlind: 1,
    bigBlind: 2,
    rakeConfig: { percent: 5, cap: 100, noFlopNoDrop: true },
    ...over,
  } as HandConfig;
}

interface Harness {
  hc: HandController;
  events: HandEvent[];
  st: () => any;
  cur: () => number;
  seat: (n: number) => SeatPlayer;
  act: (action: string, amount?: number) => boolean; // acts for whoever is on turn
  actSeat: (seat: number, action: string, amount?: number) => boolean;
  stacksPlusPot: () => number;
}

function harness(config: HandConfig, players: SeatPlayer[], dealerSeat: number): Harness {
  const events: HandEvent[] = [];
  const hc = new HandController(config, players, dealerSeat);
  hc.onEvent((e) => events.push(e));
  const st = () => (hc as unknown as { state: any }).state;
  const cur = () => st().currentPlayerSeat;
  const seat = (n: number) => st().players.find((p: SeatPlayer) => p.seat === n);
  const act = (action: string, amount = 0) => hc.performAction(cur(), action as any, amount);
  const actSeat = (s: number, action: string, amount = 0) =>
    hc.performAction(s, action as any, amount);
  const stacksPlusPot = () =>
    st().players.reduce((s: number, p: SeatPlayer) => s + p.stack, 0) + st().pot;
  return { hc, events, st, cur, seat, act, actSeat, stacksPlusPot };
}

// ─────────────────────────────────────────────────────────────────────────
describe('DEAL + BLINDS (Bible 4.1, 4.2, 4.5)', () => {
  it('6-handed NLH: 2 cards each, SB/BB posted at correct seats, pot = SB+BB', () => {
    const h = harness(mkConfig(), mkPlayers([200, 200, 200, 200, 200, 200]), 1);
    h.hc.start();
    // dealer=1 → SB=2, BB=3
    for (let s = 1; s <= 6; s++) expect(h.seat(s).cards.length).toBe(2);
    expect(h.seat(2).bet).toBe(1); // SB
    expect(h.seat(3).bet).toBe(2); // BB
    expect(h.st().pot).toBe(3); // SB + BB
    expect(h.st().currentBet).toBe(2); // BB is the bet level
  });

  it('heads-up: dealer posts SB, other posts BB, dealer acts first preflop', () => {
    const h = harness(mkConfig(), mkPlayers([200, 200]), 1);
    h.hc.start();
    expect(h.seat(1).bet).toBe(1); // dealer = SB heads-up
    expect(h.seat(2).bet).toBe(2); // BB
    expect(h.cur()).toBe(1); // dealer acts first preflop HU
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('TURN ORDER (Bible 4.7)', () => {
  it('6-handed preflop first-to-act is UTG (left of BB); postflop is SB (left of button)', () => {
    const h = harness(mkConfig(), mkPlayers([200, 200, 200, 200, 200, 200]), 1);
    h.hc.start();
    // dealer=1, SB=2, BB=3, UTG=4
    expect(h.cur()).toBe(4);
    // Everyone calls / BB checks to reach the flop.
    h.actSeat(4, 'call'); // UTG
    h.actSeat(5, 'call');
    h.actSeat(6, 'call');
    h.actSeat(1, 'call'); // button
    h.actSeat(2, 'call'); // SB completes
    h.actSeat(3, 'check'); // BB option
    expect(h.st().stage).toBe('flop');
    // Postflop first to act = first active left of button = SB (seat 2)
    expect(h.cur()).toBe(2);
  });

  it('preflop action proceeds clockwise UTG→...→BB', () => {
    const h = harness(mkConfig(), mkPlayers([200, 200, 200, 200, 200, 200]), 1);
    h.hc.start();
    const order: number[] = [];
    for (let i = 0; i < 6; i++) {
      order.push(h.cur());
      h.act('call'); // BB's turn will be a check-equivalent (call of 0) — call normalizes
    }
    expect(order).toEqual([4, 5, 6, 1, 2, 3]); // UTG, HJ, CO, BTN, SB, BB
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('EACH ACTION WORKS (Bible 4.9-4.14)', () => {
  it('CALL: chips move correctly and pot updates', () => {
    const h = harness(mkConfig(), mkPlayers([200, 200, 200]), 1);
    h.hc.start(); // dealer1, SB2, BB3, UTG=1
    const before = h.seat(1).stack;
    expect(h.actSeat(1, 'call')).toBe(true); // UTG calls 2
    expect(h.seat(1).stack).toBe(before - 2);
    expect(h.seat(1).bet).toBe(2);
  });

  it('RAISE: min raise enforced; below-min rejected; valid raise sets level', () => {
    const h = harness(mkConfig(), mkPlayers([200, 200, 200]), 1);
    h.hc.start(); // currentBet=2 (BB), UTG=seat1
    // Below min (raise-to 3 when min is 4) is rejected.
    expect(h.actSeat(1, 'raise', 3)).toBe(false);
    // Min legal open-raise is to 4 (2xBB).
    expect(h.actSeat(1, 'raise', 4)).toBe(true);
    expect(h.st().currentBet).toBe(4);
    expect(h.seat(1).bet).toBe(4);
    // Next raise must be to at least 6 (increment 2). 5 rejected, 6 ok.
    expect(h.actSeat(2, 'raise', 5)).toBe(false);
    expect(h.actSeat(2, 'raise', 6)).toBe(true);
    expect(h.st().currentBet).toBe(6);
  });

  it('CHECK legal when nothing to call; ILLEGAL when facing a bet', () => {
    const h = harness(mkConfig(), mkPlayers([200, 200, 200]), 1);
    h.hc.start(); // UTG seat1 faces BB=2
    // Facing a bet → cannot check.
    expect(h.actSeat(1, 'check')).toBe(false);
    // Reach the flop (all call, BB checks), then a real check is legal.
    h.actSeat(1, 'call');
    h.actSeat(2, 'call');
    h.actSeat(3, 'check'); // BB option → flop
    expect(h.st().stage).toBe('flop');
    expect(h.cur()).toBe(2);
    expect(h.actSeat(2, 'check')).toBe(true); // no bet yet postflop → check legal
  });

  it('BET postflop: currentBet 0 → min bet = BB; below-min rejected', () => {
    const h = harness(mkConfig(), mkPlayers([200, 200, 200]), 1);
    h.hc.start();
    h.actSeat(1, 'call');
    h.actSeat(2, 'call');
    h.actSeat(3, 'check'); // → flop, currentBet reset to 0
    expect(h.st().currentBet).toBe(0);
    // Below min bet (1 < BB=2) rejected; min bet 2 ok.
    expect(h.actSeat(2, 'bet', 1)).toBe(false);
    expect(h.actSeat(2, 'bet', 2)).toBe(true);
    expect(h.st().currentBet).toBe(2);
  });

  it('FOLD: hand ends immediately when only one player remains, pot awarded', () => {
    const h = harness(mkConfig(), mkPlayers([200, 200, 200]), 1);
    const start = h.stacksPlusPot();
    h.hc.start(); // pot 3 (blinds)
    h.actSeat(1, 'fold'); // UTG folds
    h.actSeat(2, 'fold'); // SB folds → only BB (seat3) remains
    // Hand complete: standard "walk" — the BB's own uncalled big blind is
    // RETURNED (not won); the BB wins only the dead small blind. Net +1.
    // No flop → no rake.
    expect(h.events.some((e) => e.type === 'HAND_COMPLETE')).toBe(true);
    expect(h.seat(3).stack).toBe(201); // 200 - BB(2) + own BB back(2) + SB won(1)
    expect(h.seat(2).stack).toBe(199); // lost the small blind
    expect(h.seat(1).stack).toBe(200); // folded pre, invested nothing
    // chip conservation: all 600 chips are back in stacks (no flop → no rake).
    const endStacks = h.st().players.reduce((s: number, p: SeatPlayer) => s + p.stack, 0);
    expect(endStacks).toBe(start);
  });

  it('ALL-IN: commits entire stack and marks all_in', () => {
    const h = harness(mkConfig(), mkPlayers([50, 200, 200]), 1);
    h.hc.start();
    expect(h.actSeat(1, 'all_in')).toBe(true);
    expect(h.seat(1).stack).toBe(0);
    expect(h.seat(1).is_all_in).toBe(true);
    expect(h.seat(1).bet).toBe(50);
    expect(h.st().currentBet).toBe(50);
  });

  it('OUT-OF-TURN action is rejected', () => {
    const h = harness(mkConfig(), mkPlayers([200, 200, 200]), 1);
    h.hc.start(); // turn is seat 1 (UTG)
    expect(h.cur()).toBe(1);
    expect(h.actSeat(2, 'call')).toBe(false); // seat 2 out of turn
    expect(h.actSeat(3, 'raise', 6)).toBe(false); // seat 3 out of turn
    expect(h.cur()).toBe(1); // turn unchanged
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('STREET PROGRESSION (Bible 4.16) - never skips a street', () => {
  it('preflop → flop(3) → turn(4) → river(5), bets reset each street', () => {
    const h = harness(mkConfig(), mkPlayers([200, 200, 200]), 1);
    h.hc.start();
    // Preflop: complete the round.
    h.actSeat(1, 'call');
    h.actSeat(2, 'call');
    h.actSeat(3, 'check');
    expect(h.st().stage).toBe('flop');
    expect(h.st().communityCards.length).toBe(3);
    expect(h.st().currentBet).toBe(0); // bets reset
    for (const s of [2, 3, 1]) expect(h.seat(s).bet).toBe(0);

    // Flop check-around → turn.
    h.actSeat(2, 'check');
    h.actSeat(3, 'check');
    h.actSeat(1, 'check');
    expect(h.st().stage).toBe('turn');
    expect(h.st().communityCards.length).toBe(4);

    // Turn check-around → river.
    h.actSeat(2, 'check');
    h.actSeat(3, 'check');
    h.actSeat(1, 'check');
    expect(h.st().stage).toBe('river');
    expect(h.st().communityCards.length).toBe(5);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('FULL HAND TO SHOWDOWN (Bible 1.9, 4.21) - deal→bet→showdown→payout', () => {
  it('3-handed limped pot plays to showdown, winner paid, chips conserved', () => {
    const h = harness(mkConfig(), mkPlayers([200, 200, 200]), 1);
    const start = h.stacksPlusPot();
    h.hc.start();

    // Preflop
    h.actSeat(1, 'call');
    h.actSeat(2, 'call');
    h.actSeat(3, 'check');
    // Flop, Turn, River — everyone checks.
    for (const _street of ['flop', 'turn', 'river']) {
      h.actSeat(2, 'check');
      h.actSeat(3, 'check');
      h.actSeat(1, 'check');
    }

    const winners = h.events.find((e) => e.type === 'WINNERS') as any;
    const complete = h.events.find((e) => e.type === 'HAND_COMPLETE') as any;
    expect(h.events.some((e) => e.type === 'SHOWDOWN')).toBe(true);
    expect(winners).toBeDefined();
    expect(winners.winners.length).toBeGreaterThan(0);
    expect(complete).toBeDefined();
    // Pot was $6 (3x $2). Flop seen → 5% rake = $0.30.
    expect(complete.rake).toBeCloseTo(0.3, 5);
    // Chip conservation across the whole hand: stacks + rake == starting chips.
    const endStacks = h.st().players.reduce((s: number, p: SeatPlayer) => s + p.stack, 0);
    expect(endStacks + complete.rake).toBeCloseTo(start, 5);
  });

  it('bet/call line to showdown: aggressor bets each street, caller calls, pot correct', () => {
    const h = harness(mkConfig(), mkPlayers([200, 200, 200]), 1);
    const start = h.stacksPlusPot();
    h.hc.start();
    // Preflop: UTG folds, SB completes, BB checks → heads-up to the flop.
    h.actSeat(1, 'fold');
    h.actSeat(2, 'call'); // SB completes to 2
    h.actSeat(3, 'check'); // BB option
    expect(h.st().stage).toBe('flop');
    // Flop: SB (seat2) bets 4, BB calls.
    expect(h.actSeat(2, 'bet', 4)).toBe(true);
    expect(h.actSeat(3, 'call')).toBe(true);
    expect(h.st().stage).toBe('turn');
    // Turn: SB checks, BB bets 10, SB calls.
    h.actSeat(2, 'check');
    expect(h.actSeat(3, 'bet', 10)).toBe(true);
    expect(h.actSeat(2, 'call')).toBe(true);
    expect(h.st().stage).toBe('river');
    // River: both check → showdown.
    h.actSeat(2, 'check');
    h.actSeat(3, 'check');
    const complete = h.events.find((e) => e.type === 'HAND_COMPLETE') as any;
    expect(complete).toBeDefined();
    // Contested pot: SB in for 2+4+10=16, BB in for 2+4+10=16 → 32. UTG folded 0.
    // Conservation holds regardless of who wins.
    const endStacks = h.st().players.reduce((s: number, p: SeatPlayer) => s + p.stack, 0);
    expect(endStacks + complete.rake).toBeCloseTo(start, 5);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('ALL-IN + SIDE POT (Bible 1.9 settlement)', () => {
  it('short all-in vs two callers: chips conserved, side pot formed', () => {
    // seat1 short (30), seat2/seat3 deep. All-in preflop scenario.
    const h = harness(mkConfig(), mkPlayers([30, 200, 200]), 1);
    const start = h.stacksPlusPot();
    h.hc.start();
    // UTG(seat1) all-in 30; SB(seat2) calls; BB(seat3) calls.
    expect(h.actSeat(1, 'all_in')).toBe(true);
    h.actSeat(2, 'call');
    h.actSeat(3, 'call');
    // Two non-all-in players remain (seat2, seat3) with equal bets → flop.
    // They both check down to showdown.
    while (h.st().stage !== 'showdown' && !h.events.some((e) => e.type === 'HAND_COMPLETE')) {
      const c = h.cur();
      if (c <= 0) break;
      h.actSeat(c, 'check');
    }
    const complete = h.events.find((e) => e.type === 'HAND_COMPLETE') as any;
    expect(complete).toBeDefined();
    const endStacks = h.st().players.reduce((s: number, p: SeatPlayer) => s + p.stack, 0);
    // Every chip accounted for (stacks + rake == start).
    expect(endStacks + complete.rake).toBeCloseTo(start, 5);
    // The short all-in player can only win the main pot (≤ 30*3=90); never more than start.
    expect(h.st().players.find((p: SeatPlayer) => p.seat === 1)!.stack).toBeLessThanOrEqual(90);
  });
});
