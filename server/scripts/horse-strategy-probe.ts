/**
 * HORSE STRATEGY PROBE (2026-09-02, horse brain audit phase 1)
 *
 * Measures what the brain ACTUALLY does in canonical spots — open frequency
 * by seat, blind defence, 3-bet response, c-bet/probe/defence rates by street
 * — with random hole cards, so the numbers can be read against solver
 * targets. This is how the button-opens-23% and PLO-blind-cannot-call leaks
 * were found; nothing in the test suite measures frequencies across a range.
 *
 *     cd server && VARIANTS=nlh npx tsx scripts/horse-strategy-probe.ts
 *     VARIANTS=plo4,plo6,plo8,short_deck npx tsx scripts/horse-strategy-probe.ts
 *
 * Solver stores are empty here (no DB), so postflop numbers are the
 * heuristic layers; the preflop push/fold charts likewise. "fold" in a
 * "hero opened, faces 3-bet" row is over ALL dealt hands, not the opening
 * range, so read it as "share of all hands that continue".
 */
import { HorseLogic } from '../src/engine/HorseLogic.js';
import { HorseMind } from '../src/engine/HorseMind.js';
import { SUITS, RANKS } from '../src/engine/PokerEngine.js';
import type { Card, SeatPlayer, ActionRecord, HandStage } from '../src/types.js';

function deck(shortDeck = false): Card[] {
  const d: Card[] = [];
  for (const s of SUITS)
    for (const r of RANKS) {
      if (shortDeck && ['2', '3', '4', '5'].includes(r)) continue;
      d.push({ rank: r, suit: s });
    }
  return d;
}
function shuffle<T>(a: T[]): T[] {
  const b = [...a];
  for (let i = b.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [b[i], b[j]] = [b[j], b[i]];
  }
  return b;
}
function mk(seat: number, o: Partial<SeatPlayer> = {}): SeatPlayer {
  return {
    seat,
    user_id: 'u' + seat,
    username: 'U' + seat,
    stack: 200,
    bet: 0,
    totalInvested: 0,
    cards: [],
    is_folded: false,
    is_all_in: false,
    is_sitting_out: false,
    ...o,
  };
}
const hole = (v: string) =>
  v.startsWith('plo6')
    ? 6
    : v.startsWith('plo5')
      ? 5
      : v.startsWith('plo')
        ? 4
        : v === 'pineapple'
          ? 3
          : 2;

function tally(
  name: string,
  n: number,
  f: () => { action: string; amount?: number; ctx?: number }
) {
  const counts: Record<string, number> = {};
  const sizes: number[] = [];
  for (let i = 0; i < n; i++) {
    const r = f();
    counts[r.action] = (counts[r.action] || 0) + 1;
    if (r.amount && r.ctx) sizes.push(r.amount / r.ctx);
  }
  const parts = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}:${((100 * v) / n).toFixed(0)}%`);
  const sz = sizes.length
    ? ` size~${(sizes.reduce((a, b) => a + b, 0) / sizes.length).toFixed(2)}x`
    : '';
  console.log(name.padEnd(58), parts.join(' '), sz);
}

const BB = 2;
const rec = (seat: number, action: any, amount: number, i: number): ActionRecord => ({
  seat,
  userId: 'u' + seat,
  action,
  amount,
  timestamp: 1000 + i,
  stage: 'preflop',
});

function preflopSpot(
  variant: string,
  heroSeat: number,
  dealerSeat: number,
  nPlayers: number,
  hist: (seats: number[]) => ActionRecord[],
  stackBB = 100,
  mode: 'cash' | 'tournament' = 'cash',
  opts: any = {}
) {
  return () => {
    const d = shuffle(deck(variant === 'short_deck'));
    const hc = hole(variant);
    const seats = Array.from({ length: nPlayers }, (_, i) => i + 1);
    const players = seats.map((s) => mk(s, { stack: stackBB * BB, cards: d.splice(0, hc) }));
    const history = hist(seats);
    let currentBet = BB;
    let pot = 1.5 * BB;
    const bets = new Map<number, number>();
    const di = seats.indexOf(dealerSeat);
    const sb = seats[(di + 1) % nPlayers];
    const bb = seats[(di + 2) % nPlayers];
    bets.set(sb, BB / 2);
    bets.set(bb, BB);
    let lastRaiseSize = BB;
    for (const a of history) {
      if (a.action === 'fold') {
        players.find((p) => p.seat === a.seat)!.is_folded = true;
        continue;
      }
      if (a.action === 'raise' || a.action === 'bet') {
        lastRaiseSize = a.amount - currentBet;
        currentBet = a.amount;
      }
      const prev = bets.get(a.seat) || 0;
      const total = a.action === 'call' ? currentBet : a.amount;
      pot += total - prev;
      bets.set(a.seat, total);
    }
    for (const p of players) {
      p.bet = bets.get(p.seat) || 0;
      p.totalInvested = p.bet;
      p.stack = stackBB * BB - p.bet;
    }
    const hero = players.find((p) => p.seat === heroSeat)!;
    const gs: any = {
      players,
      communityCards: [],
      pot,
      currentBet,
      minRaise: Math.max(BB, lastRaiseSize),
      stage: 'preflop' as HandStage,
      gameVariant: variant,
      bigBlind: BB,
      dealerSeat,
      actionHistory: history,
      gameMode: mode,
      ante: 0,
      format: mode === 'cash' ? 'cash' : 'mtt',
      ...opts,
    };
    const dec = HorseLogic.decide(hero, gs, 'balanced', {}, { mind: false });
    return { action: dec.action, amount: dec.amount, ctx: BB };
  };
}

const T = {
  ante: 0.25,
  bigBlindAnte: true,
  tournament: { playersLeft: 40, spotsPaid: 9, avgStackChips: 60 },
};
const variants = (process.env.VARIANTS ?? 'nlh,plo4,plo6,plo8,short_deck').split(',');
for (const variant of variants) {
  console.log('\n=== ' + variant + ' preflop, 6-max, dealer seat 6, 100bb cash ===');
  tally(
    variant + ' UTG first in',
    1500,
    preflopSpot(variant, 3, 6, 6, () => [])
  );
  tally(
    variant + ' BTN first in (folded to)',
    1500,
    preflopSpot(variant, 6, 6, 6, () => [
      rec(3, 'fold', 0, 0),
      rec(4, 'fold', 0, 1),
      rec(5, 'fold', 0, 2),
    ])
  );
  tally(
    variant + ' SB first in (folded to)',
    1500,
    preflopSpot(variant, 1, 6, 6, () => [
      rec(3, 'fold', 0, 0),
      rec(4, 'fold', 0, 1),
      rec(5, 'fold', 0, 2),
      rec(6, 'fold', 0, 3),
    ])
  );
  tally(
    variant + ' BB vs BTN open 2.5x',
    1500,
    preflopSpot(variant, 2, 6, 6, () => [
      rec(3, 'fold', 0, 0),
      rec(4, 'fold', 0, 1),
      rec(5, 'fold', 0, 2),
      rec(6, 'raise', 5, 3),
      rec(1, 'fold', 0, 4),
    ])
  );
  tally(
    variant + ' BB vs UTG open 2.5x',
    1500,
    preflopSpot(variant, 2, 6, 6, () => [
      rec(3, 'raise', 5, 0),
      rec(4, 'fold', 0, 1),
      rec(5, 'fold', 0, 2),
      rec(6, 'fold', 0, 3),
      rec(1, 'fold', 0, 4),
    ])
  );
  tally(
    variant + ' BTN vs UTG open 2.5x',
    1500,
    preflopSpot(variant, 6, 6, 6, () => [
      rec(3, 'raise', 5, 0),
      rec(4, 'fold', 0, 1),
      rec(5, 'fold', 0, 2),
    ])
  );
  tally(
    variant + ' UTG opened, faces BTN 3bet to 8bb',
    1500,
    preflopSpot(variant, 3, 6, 6, () => [
      rec(3, 'raise', 5, 0),
      rec(4, 'fold', 0, 1),
      rec(5, 'fold', 0, 2),
      rec(6, 'raise', 16, 3),
      rec(1, 'fold', 0, 4),
      rec(2, 'fold', 0, 5),
    ])
  );
  console.log('--- tournament, ante ---');
  tally(
    variant + ' T25 CO first in',
    1500,
    preflopSpot(
      variant,
      5,
      6,
      6,
      () => [rec(3, 'fold', 0, 0), rec(4, 'fold', 0, 1)],
      25,
      'tournament',
      T
    )
  );
  tally(
    variant + ' T12 CO first in',
    1500,
    preflopSpot(
      variant,
      5,
      6,
      6,
      () => [rec(3, 'fold', 0, 0), rec(4, 'fold', 0, 1)],
      12,
      'tournament',
      T
    )
  );
  tally(
    variant + ' T25 BB vs BTN open 2.2x',
    1500,
    preflopSpot(
      variant,
      2,
      6,
      6,
      () => [
        rec(3, 'fold', 0, 0),
        rec(4, 'fold', 0, 1),
        rec(5, 'fold', 0, 2),
        rec(6, 'raise', 4.4, 3),
        rec(1, 'fold', 0, 4),
      ],
      25,
      'tournament',
      T
    )
  );
}

function postflopSpot(
  variant: string,
  street: 'flop' | 'turn' | 'river',
  heroIp: boolean,
  facing: number,
  heroPfr = true,
  mode: 'cash' | 'tournament' = 'cash'
) {
  return () => {
    const d = shuffle(deck(variant === 'short_deck'));
    const hc = hole(variant);
    const nBoard = street === 'flop' ? 3 : street === 'turn' ? 4 : 5;
    const dealer = 6;
    const heroSeat = heroIp ? 6 : 2;
    const villSeat = heroIp ? 2 : 6;
    const players = [2, 6].map((s) => mk(s, { stack: 200, cards: d.splice(0, hc) }));
    const board = d.splice(0, nBoard);
    const pfr = heroPfr ? heroSeat : villSeat;
    const caller = heroPfr ? villSeat : heroSeat;
    const history: ActionRecord[] = [rec(pfr, 'raise', 5, 0), rec(caller, 'call', 5, 1)];
    let ts = 10;
    for (const st of ['flop', 'turn', 'river'] as HandStage[]) {
      if (st === street) break;
      history.push({
        seat: 2,
        userId: 'u2',
        action: 'check',
        amount: 0,
        timestamp: ts++,
        stage: st,
      });
      history.push({
        seat: 6,
        userId: 'u6',
        action: 'check',
        amount: 0,
        timestamp: ts++,
        stage: st,
      });
    }
    let pot = 10.5;
    let currentBet = 0;
    if (facing > 0) {
      const bet = Math.round(pot * facing);
      history.push({
        seat: villSeat,
        userId: 'u' + villSeat,
        action: 'bet',
        amount: bet,
        timestamp: ts++,
        stage: street,
      });
      players.find((p) => p.seat === villSeat)!.bet = bet;
      pot += bet;
      currentBet = bet;
    } else if (heroIp) {
      history.push({
        seat: villSeat,
        userId: 'u' + villSeat,
        action: 'check',
        amount: 0,
        timestamp: ts++,
        stage: street,
      });
    }
    for (const p of players) {
      p.totalInvested = 5 + p.bet;
      p.stack = 200 - p.totalInvested;
    }
    const hero = players.find((p) => p.seat === heroSeat)!;
    const gs: any = {
      players,
      communityCards: board,
      pot,
      currentBet,
      minRaise: Math.max(BB, currentBet),
      stage: street,
      gameVariant: variant,
      bigBlind: BB,
      dealerSeat: dealer,
      actionHistory: history,
      gameMode: mode,
      ante: 0,
      format: mode === 'cash' ? 'cash' : 'mtt',
    };
    const dec = HorseLogic.decide(hero, gs, 'balanced', {}, { mind: true });
    return { action: dec.action, amount: dec.amount, ctx: facing > 0 ? pot - currentBet : pot };
  };
}
for (const variant of variants) {
  console.log('\n=== ' + variant + ' postflop HU, cash 100bb ===');
  for (const st of ['flop', 'turn', 'river'] as const) {
    tally(`${variant} ${st} hero PFR IP, checked to`, 1000, postflopSpot(variant, st, true, 0));
    tally(`${variant} ${st} hero PFR OOP, first to act`, 1000, postflopSpot(variant, st, false, 0));
    tally(
      `${variant} ${st} hero CALLER IP facing 33%`,
      1000,
      postflopSpot(variant, st, true, 0.33, false)
    );
    tally(
      `${variant} ${st} hero CALLER IP facing 75%`,
      1000,
      postflopSpot(variant, st, true, 0.75, false)
    );
    tally(
      `${variant} ${st} hero CALLER OOP facing 75%`,
      1000,
      postflopSpot(variant, st, false, 0.75, false)
    );
  }
}
HorseMind.reset();
