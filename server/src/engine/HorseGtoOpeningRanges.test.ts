/**
 * V70 GTO OPENING RANGES (Dan 2026-10-31): "AUDIT AND IMPROVE THE HORSES
 * OPENING RANGES IN BOTH TOURNAMENTS AND CASH GAMES ... BASED ON GTO".
 *
 * Every number here is measured end to end through HorseLogic.decide on an
 * unopened pot folded to the seat (every graph owner after the preflop
 * reference included), combo-weighted over the 169 classes. See
 * docs/changelog/2026-10-31-v70-gto-opening-ranges.md for the audit.
 */
import { describe, expect, it } from 'vitest';
import { HorseLogic, type HorseGameStateV2 } from './HorseLogic.js';
import { seedFastRandom } from './HorseEval.js';
import {
  GTO_OPEN_CHARTS,
  HAND_CLASSES,
  chartWidth,
  gtoOpenBar,
  gtoOpenOrder,
  parseChart,
  scoreAtShare,
} from './HorseGtoOpeningRanges.js';
import type { ActionRecord, Card, HorseStyle, SeatPlayer } from '../types.js';

const SUITS = ['spades', 'hearts', 'diamonds', 'clubs'] as const;
const RANKS = 'AKQJT98765432'.split('');
const BB = 2;
const SEEDS = 12;

type Ctx = {
  seats: number;
  stackBB: number;
  mode: 'cash' | 'tournament';
  ante: boolean;
  format?: 'mtt' | 'spin' | 'hu_sng';
};

function holeFor(cls: string, s: number): Card[] {
  const su = (s * 3) % 4;
  const suited = cls.length === 3 && cls[2] === 's';
  const s2 = suited ? su : (su + 1 + (s % 3)) % 4;
  return [{ rank: cls[0], suit: SUITS[su] } as Card, { rank: cls[1], suit: SUITS[s2] } as Card];
}

function decideOpen(
  ctx: Ctx,
  posIdx: number,
  cls: string,
  seed: number,
  style: HorseStyle,
  opts: Record<string, unknown>
) {
  const n = ctx.seats;
  // Heads-up the dealer (seat 2) posts the small blind.
  const hu = n === 2;
  const sbSeat = hu ? 2 : 1;
  const bbSeat = hu ? 1 : 2;
  const order = hu ? [2] : [...Array(n - 2).keys()].map((k) => 3 + k).concat([1]);
  const heroSeat = order[posIdx];
  const hole = holeFor(cls, seed);
  const used = new Set(hole.map((h) => h.rank + h.suit));
  const deck: Card[] = [];
  for (const r of RANKS)
    for (const su of SUITS) if (!used.has(r + su)) deck.push({ rank: r, suit: su } as Card);
  const ante = ctx.ante ? 2 : 0;
  const players: SeatPlayer[] = [];
  for (let seat = 1; seat <= n; seat++) {
    const bet = seat === sbSeat ? 1 : seat === bbSeat ? 2 : 0;
    players.push({
      seat,
      user_id: `rfi-${seat}`,
      username: `Rfi${seat}`,
      stack: ctx.stackBB * BB - bet - (seat === bbSeat ? ante : 0),
      bet,
      totalInvested: bet + (seat === bbSeat ? ante : 0),
      cards: seat === heroSeat ? hole : [deck[seat * 2], deck[seat * 2 + 1]],
      is_folded: false,
      is_all_in: false,
      is_sitting_out: false,
      is_horse: true,
    } as SeatPlayer);
  }
  const history: ActionRecord[] = [];
  let ts = 100;
  for (const seat of order.concat([bbSeat])) {
    if (seat === heroSeat) break;
    players[seat - 1].is_folded = true;
    history.push({
      seat,
      userId: `rfi-${seat}`,
      action: 'fold',
      amount: 0,
      timestamp: ts++,
      stage: 'preflop',
    } as ActionRecord);
  }
  const gs = {
    players,
    communityCards: [],
    pot: 3 + ante,
    currentBet: 2,
    minRaise: 2,
    lastRaise: 2,
    stage: 'preflop',
    gameVariant: 'nlh',
    bigBlind: BB,
    dealerSeat: hu ? 2 : n,
    actionHistory: history,
    gameMode: ctx.mode,
    ante,
    bigBlindAnte: ctx.ante,
    format: ctx.mode === 'cash' ? 'cash' : (ctx.format ?? 'mtt'),
    ...(ctx.mode === 'tournament'
      ? {
          tournament: {
            schemaVersion: 1,
            contextStatus: 'complete',
            contextIssues: [],
            playersLeft: n <= 3 ? n : 180,
            spotsPaid: n <= 3 ? 1 : 30,
            entrants: n <= 3 ? n : 300,
            avgStackChips: ctx.stackBB * BB,
            medianStackChips: ctx.stackBB * BB,
            seatsPerTable: n,
            playersAtTable: n,
            nearBubble: false,
            inMoney: false,
            payoutPct: n <= 3 ? [100] : [30, 20, 14, 10, 8, 6, 4, 3, 3, 2],
            currentSmallBlind: 1,
            currentBigBlind: 2,
            currentAnte: ante,
            anteType: ctx.ante ? 'big_blind' : 'none',
            nextSmallBlind: 2,
            nextBigBlind: 4,
            nextAnte: ante * 2,
            nextBlindInMin: 10,
          },
        }
      : {}),
  } as unknown as HorseGameStateV2;
  seedFastRandom(seed * 7919 + posIdx * 104729 + cls.charCodeAt(0) * 31 + cls.length);
  const d = HorseLogic.decide(players[heroSeat - 1], gs, style, {}, {
    mind: false,
    telemetry: false,
    ...opts,
  } as never);
  const raise = d.action === 'raise' || d.action === 'bet' || d.action === 'all_in';
  return { raise, jam: d.action === 'all_in', size: raise ? (d.amount ?? 0) / BB : 0 };
}

const cache = new Map<string, Map<string, { raise: number; jam: number; size: number }>>();
function seatCells(
  ctx: Ctx,
  posIdx: number,
  style: HorseStyle = 'balanced',
  opts: Record<string, unknown> = {}
) {
  const key = JSON.stringify([ctx, posIdx, style, opts]);
  const hit = cache.get(key);
  if (hit) return hit;
  const out = new Map<string, { raise: number; jam: number; size: number }>();
  for (const h of HAND_CLASSES) {
    let r = 0;
    let j = 0;
    let sz = 0;
    for (let s = 0; s < SEEDS; s++) {
      const d = decideOpen(ctx, posIdx, h.cls, s + 1, style, opts);
      if (d.raise) {
        r++;
        sz += d.size;
      }
      if (d.jam) j++;
    }
    out.set(h.cls, { raise: r / SEEDS, jam: j / SEEDS, size: r ? sz / r : 0 });
  }
  cache.set(key, out);
  return out;
}

function rfi(cells: Map<string, { raise: number }>): number {
  let w = 0;
  for (const h of HAND_CLASSES) w += cells.get(h.cls)!.raise * h.combos;
  return (100 * w) / 1326;
}

const CASH6: Ctx = { seats: 6, stackBB: 100, mode: 'cash', ante: false };
const CASH9: Ctx = { seats: 9, stackBB: 100, mode: 'cash', ante: false };
const MTT9: Ctx = { seats: 9, stackBB: 50, mode: 'tournament', ante: true };
const MTT9_20: Ctx = { seats: 9, stackBB: 20, mode: 'tournament', ante: true };
const MTT8: Ctx = { seats: 8, stackBB: 50, mode: 'tournament', ante: true };
const HU25: Ctx = { seats: 2, stackBB: 25, mode: 'tournament', ante: true, format: 'hu_sng' };
const SPIN18: Ctx = { seats: 3, stackBB: 18, mode: 'tournament', ante: false, format: 'spin' };
const OFF = { v70GtoOpeningRanges: false };

function share(cells: Map<string, { raise: number; jam: number }>, key: 'raise' | 'jam'): number {
  let w = 0;
  for (const h of HAND_CLASSES) w += cells.get(h.cls)![key] * h.combos;
  return (100 * w) / 1326;
}

describe('the reference charts', () => {
  it('parse ranges and keep each seat inside the previous seat', () => {
    expect(parseChart('A2s+')).toMatchObject({ A2s: 1, AKs: 1 });
    expect(parseChart('22-44:0.5')).toEqual({ '22': 0.5, '33': 0.5, '44': 0.5 });
    expect(parseChart('K5o-K7o:0.3')).toEqual({ K5o: 0.3, K6o: 0.3, K7o: 0.3 });
    // Later seats open wider: every chart is wider than the one before it.
    for (let k = 8; k > 2; k--) expect(chartWidth(k - 1)).toBeGreaterThan(chartWidth(k));
    // The orders are total and the bars descend with the seat.
    for (let k = 1; k <= 8; k++) expect(new Set(gtoOpenOrder(k)).size).toBe(169);
    for (let k = 8; k > 2; k--) expect(gtoOpenBar(k - 1, false)).toBeLessThan(gtoOpenBar(k, false));
    // The share scale is strictly monotone.
    let prev = Infinity;
    for (let q = 0.02; q < 0.98; q += 0.02) {
      const s = scoreAtShare(q);
      expect(s).toBeLessThan(prev);
      prev = s;
    }
    expect(GTO_OPEN_CHARTS[2]['72o'] ?? 0).toBe(0);
  });
});

describe('cash 6-max 100bb, default style: inside the GTO band', () => {
  const bands: [string, number, number][] = [
    ['UTG', 14, 18.5],
    ['HJ', 19, 23],
    ['CO', 24.5, 30],
    ['BTN', 40, 48],
    ['SB', 39, 48],
  ];
  bands.forEach(([name, lo, hi], i) => {
    it(`${name} raises ${lo}-${hi}% first in`, () => {
      const w = rfi(seatCells(CASH6, i));
      expect(w).toBeGreaterThanOrEqual(lo);
      expect(w).toBeLessThanOrEqual(hi);
    });
  });

  it('the hijack opens small pairs and suited kings/connectors instead of QTo/JTo', () => {
    const hj = seatCells(CASH6, 1);
    for (const cls of ['22', '33', 'K9s', 'K8s', '98s', '87s'])
      expect(hj.get(cls)!.raise, cls).toBeGreaterThanOrEqual(0.6);
    for (const cls of ['QTo', 'JTo']) expect(hj.get(cls)!.raise, cls).toBeLessThanOrEqual(0.1);
    // The off arm is what the audit found: the reverse.
    const off = seatCells(CASH6, 1, 'balanced', OFF);
    for (const cls of ['22', 'K9s', 'K8s', '87s'])
      expect(off.get(cls)!.raise, cls).toBeLessThanOrEqual(0.1);
    expect(off.get('QTo')!.raise).toBeGreaterThanOrEqual(0.75);
  });

  it('the button opens the suited hands and folds the offsuit rags', () => {
    const btn = seatCells(CASH6, 3);
    for (const cls of ['K2s', 'Q4s', 'J5s', '86s', '75s', '64s', '54s', 'A2o', 'T9o'])
      expect(btn.get(cls)!.raise, cls).toBeGreaterThanOrEqual(0.75);
    for (const cls of ['72o', '83o', '94o', 'T4o', 'J5o', '62s'])
      expect(btn.get(cls)!.raise, cls).toBeLessThanOrEqual(0.1);
  });

  it('under the gun opens small pairs and suited aces, not weak offsuit broadways', () => {
    const utg = seatCells(CASH6, 0);
    for (const cls of ['66', '77', 'A5s', 'A4s', 'A3s', 'QTs', 'JTs', 'ATo', 'KJo'])
      expect(utg.get(cls)!.raise, cls).toBeGreaterThanOrEqual(0.6);
    for (const cls of ['KTo', 'QJo', 'QTo', 'J9o', 'A9o', 'A8o', 'K9o', 'T8o', '97s'])
      expect(utg.get(cls)!.raise, cls).toBeLessThanOrEqual(0.25);
    const off = seatCells(CASH6, 0, 'balanced', OFF);
    expect(off.get('QJo')!.raise).toBeGreaterThanOrEqual(0.5);
    expect(off.get('44')!.raise).toBeLessThanOrEqual(0.1);
  });

  it('a looser style stays looser and a tighter style tighter, seat by seat', () => {
    for (let i = 0; i < 4; i++) {
      const lag = rfi(seatCells(CASH6, i, 'lag'));
      const bal = rfi(seatCells(CASH6, i, 'balanced'));
      const grind = rfi(seatCells(CASH6, i, 'grinder'));
      expect(lag).toBeGreaterThan(bal);
      expect(grind).toBeLessThan(bal);
    }
  });

  it('the small blind opens bigger than the button', () => {
    const sz = (cells: Map<string, { raise: number; size: number }>) => {
      let w = 0;
      let s = 0;
      for (const [, c] of cells) {
        w += c.raise;
        s += c.raise * c.size;
      }
      return s / w;
    };
    expect(sz(seatCells(CASH6, 4))).toBeGreaterThan(sz(seatCells(CASH6, 3)) + 0.3);
  });
});

describe('nine-handed: every early seat is its own seat', () => {
  it('UTG < UTG+1 < UTG+2 < LJ, and the lojack plays the 6-max UTG range', () => {
    const w = [0, 1, 2, 3].map((i) => rfi(seatCells(CASH9, i)));
    expect(w[0]).toBeGreaterThanOrEqual(9);
    expect(w[0]).toBeLessThanOrEqual(13);
    for (let i = 1; i < 4; i++) expect(w[i]).toBeGreaterThan(w[i - 1] + 0.5);
    expect(Math.abs(w[3] - rfi(seatCells(CASH6, 0)))).toBeLessThan(1);
  });
});

describe('MTT, 9-handed, big blind ante', () => {
  const bands: [string, number, number, number][] = [
    ['UTG', 0, 14, 19],
    ['HJ', 4, 22, 27.5],
    ['CO', 5, 27, 34],
    ['BTN', 6, 43, 52],
  ];
  for (const [name, i, lo, hi] of bands) {
    it(`${name} raises ${lo}-${hi}% first in at 50bb`, () => {
      const w = rfi(seatCells(MTT9, i));
      expect(w).toBeGreaterThanOrEqual(lo);
      expect(w).toBeLessThanOrEqual(hi);
    });
  }

  it('the jam-or-fold zones are untouched: a 20bb stack plays exactly as before', () => {
    for (const i of [0, 6, 7]) {
      const on = seatCells(MTT9_20, i);
      const off = seatCells(MTT9_20, i, 'balanced', OFF);
      for (const h of HAND_CLASSES) expect(on.get(h.cls), h.cls).toEqual(off.get(h.cls));
    }
  });

  it('eight-handed, every seat opens wider than the one before it', () => {
    const w = [0, 1, 2, 3, 4, 5].map((i) => rfi(seatCells(MTT8, i)));
    for (let i = 1; i < w.length; i++) expect(w[i]).toBeGreaterThan(w[i - 1] + 0.5);
    expect(w[0]).toBeGreaterThanOrEqual(15);
    expect(w[0]).toBeLessThanOrEqual(20);
  });
});

describe('short-handed tournaments', () => {
  it('the heads-up small blind plays the large majority of its buttons at 25bb', () => {
    const on = seatCells(HU25, 0);
    // raise share, plus the limp band (VPIP is checked through the off arm's fold rate)
    expect(share(on, 'raise')).toBeGreaterThanOrEqual(60);
    expect(share(on, 'jam')).toBeLessThan(3);
    const off = seatCells(HU25, 0, 'balanced', OFF);
    expect(share(off, 'raise')).toBeLessThan(55);
  });

  it('a three-handed spin button opens small at 18bb instead of jam-or-fold', () => {
    const on = seatCells(SPIN18, 0);
    expect(share(on, 'raise')).toBeGreaterThanOrEqual(45);
    expect(share(on, 'jam')).toBeLessThan(3);
    const off = seatCells(SPIN18, 0, 'balanced', OFF);
    expect(share(off, 'jam')).toBeGreaterThan(20);
  });
});
