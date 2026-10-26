/**
 * LAW - A HAND THAT CALLED THE RIVER IS SHOWN AT THE TABLE (Dan 2026-10-25)
 *
 * Dan: "WHEN A PLAYER CALLS A BET ON THE RIVER AND HIS HAND IS MUCKED, USERS
 * SHOULD STILL BE ABLE TO SEE THE HAND" and then "show the hand at call down".
 *
 * In a cash game a hand that cannot win or tie may muck - EXCEPT a hand whose
 * last river decision was a call (a plain call, or an all-in for no more than
 * the bet it faced). That hand paid to see the bet, so the engine tables it,
 * win or lose. A checked-down loser may still muck, and a call on an earlier
 * street does not count. The fuller set of scenarios lives beside the rest of
 * the showdown rules in HandController.showdownRules.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { HandController } from './HandController.js';
import type { Card, HandConfig, HandEvent, SeatPlayer, ShowdownResult } from '../types.js';

const c = (rank: Card['rank'], suit: Card['suit']): Card => ({ rank, suit });
const BOARD: Card[] = [
  c('K', 'spades'),
  c('Q', 'diamonds'),
  c('9', 'clubs'),
  c('5', 'hearts'),
  c('3', 'spades'),
];

function play(riverCall: boolean): Map<number, ShowdownResult> {
  const players = [1, 2].map(
    (seat) =>
      ({
        seat,
        user_id: `u${seat}`,
        username: `P${seat}`,
        stack: 200,
        bet: 0,
        totalInvested: 0,
        cards: [],
        is_folded: false,
        is_all_in: false,
        is_sitting_out: false,
      }) as SeatPlayer
  );
  const config = {
    tableId: 't1',
    handNumber: 1,
    gameVariant: 'nlh',
    smallBlind: 1,
    bigBlind: 2,
    rakeConfig: { percent: 5, cap: 100, noFlopNoDrop: true },
  } as HandConfig;
  const events: HandEvent[] = [];
  const hc = new HandController(config, players, 1);
  hc.onEvent((e) => events.push(e));
  const st = () => (hc as unknown as { state: any }).state;
  hc.start();
  hc.performAction(1, 'call' as any, 0);
  hc.performAction(2, 'check' as any, 0);
  for (let i = 0; i < 2; i++) {
    hc.performAction(2, 'check' as any, 0);
    hc.performAction(1, 'check' as any, 0);
  }
  expect(st().stage).toBe('river');
  hc.performAction(2, 'check' as any, 0);
  if (riverCall) hc.performAction(1, 'bet' as any, 4);
  st().communityCards.length = 0;
  st().communityCards.push(...BOARD);
  // The river caller (or, checked down, the second hand to show) is the loser.
  const winner = riverCall ? 1 : 2;
  const loser = riverCall ? 2 : 1;
  st().players.find((p: SeatPlayer) => p.seat === winner).cards = [
    c('A', 'spades'),
    c('A', 'hearts'),
  ];
  st().players.find((p: SeatPlayer) => p.seat === loser).cards = [
    c('7', 'diamonds'),
    c('2', 'clubs'),
  ];
  if (riverCall) hc.performAction(2, 'call' as any, 0);
  else hc.performAction(1, 'check' as any, 0);
  const ev = events.find((e) => e.type === 'SHOWDOWN') as
    | { type: 'SHOWDOWN'; results: ShowdownResult[] }
    | undefined;
  return new Map((ev?.results ?? []).map((r) => [r.seat, r]));
}

describe('a hand that called the river is shown at the table', () => {
  it('the beaten river caller is tabled', () => {
    const sd = play(true);
    expect(sd.get(2)!.mucked).toBe(false);
  });

  it('a beaten hand that never called a river bet may still muck', () => {
    const sd = play(false);
    expect(sd.get(2)!.mucked).toBe(false); // first to show on a checked river, and wins
    expect(sd.get(1)!.mucked).toBe(true); // beaten, checked down: may muck
  });

  it('the engine keeps the river-call record and the reveal rule together', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('./HandController.ts', import.meta.url), 'utf8');
    expect(src).toMatch(
      /action === 'call' \|\|\s*\(action === 'all_in' && player\.stack <= bettingState\.toCall/
    );
    expect(src).toMatch(/if \(this\.riverCalled\.get\(r\.seat\) === true\) mustShow = true;/);
  });
});
