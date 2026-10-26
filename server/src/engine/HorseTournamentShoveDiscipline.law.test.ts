/**
 * TOURNAMENT SHOVE DISCIPLINE (Dan 2026-10-25, binding).
 *
 * "BIGGER STACKS SHOULD NOT BE OPEN RIPPING 35+ BIGS UTG OR PERIOD!"
 *
 * A tournament horse shoves preflop only at a depth where shoving is the
 * real strategy: first in <=12bb from UTG to the hijack, <=15bb from the cutoff, <=20bb from the button and small blind, <=25bb over one raise, <=40bb over a
 * 3-bet. Deeper, the same aggression is a sized raise. A stack that covers
 * everyone never shoves more than the biggest live opponent can call.
 * See HorseTournamentShoveDiscipline.ts for the production measurements.
 */
import { describe, it, expect } from 'vitest';
import {
  tournamentShoveDiscipline,
  TOURNAMENT_OPEN_SHOVE_MAX_BB,
  TOURNAMENT_EARLY_OPEN_SHOVE_MAX_BB,
  TOURNAMENT_THREE_BET_SHOVE_MAX_BB,
  TOURNAMENT_FOUR_BET_SHOVE_MAX_BB,
} from './HorseTournamentShoveDiscipline.js';
import { HorseLogic } from './HorseLogic.js';
import type {
  ActionRecord,
  Card,
  CardRank,
  CardSuit,
  HorseDecision,
  SeatPlayer,
} from '../types.js';

const BB = 100;
const SUITS: Record<string, CardSuit> = { c: 'clubs', d: 'diamonds', h: 'hearts', s: 'spades' };
function cards(text: string): Card[] {
  const out: Card[] = [];
  for (let i = 0; i + 1 < text.length; i += 2)
    out.push({ rank: text[i] as CardRank, suit: SUITS[text[i + 1]] });
  return out;
}

interface Opts {
  heroStack?: number;
  oppStack?: number;
  heroSeat?: number;
  history?: Partial<ActionRecord>[];
  currentBet?: number;
  bets?: Record<number, number>;
  gameMode?: 'cash' | 'tournament';
  allInOrFold?: boolean;
  structure?: 'no_limit' | 'pot_limit' | 'fixed_limit';
  stacks?: Record<number, number>;
  hole?: string;
}

/** Six seats, button 6, sb 1, bb 2; hero acts in `heroSeat`. */
function table(o: Opts = {}) {
  const heroSeat = o.heroSeat ?? 3;
  const bets: Record<number, number> = { 1: BB / 2, 2: BB, ...(o.bets ?? {}) };
  const players = Array.from({ length: 6 }, (_, i) => {
    const seat = i + 1;
    const bet = bets[seat] ?? 0;
    const total =
      o.stacks?.[seat] ?? (seat === heroSeat ? (o.heroStack ?? 5000) : (o.oppStack ?? 5000));
    return {
      seat,
      user_id: seat === heroSeat ? 'hero' : `p${seat}`,
      stack: total - bet,
      bet,
      is_folded: false,
      is_all_in: false,
      is_sitting_out: false,
      cards: seat === heroSeat ? cards(o.hole ?? 'AsAh') : [],
    };
  });
  const currentBet = o.currentBet ?? BB;
  const hero = players.find((p) => p.seat === heroSeat)! as unknown as SeatPlayer;
  const heroTotal = hero.stack + hero.bet;
  const gs = {
    players,
    communityCards: [],
    pot: Object.values(bets).reduce((a, b) => a + b, 0),
    currentBet,
    minRaise: BB,
    stage: 'preflop',
    gameVariant: 'nlh',
    bigBlind: BB,
    smallBlind: BB / 2,
    dealerSeat: 6,
    blindSeats: { smallBlind: 1, bigBlind: 2 },
    format: 'mtt',
    gameMode: o.gameMode ?? 'tournament',
    tournament: { id: 't1' },
    allInOrFold: o.allInOrFold,
    stateSchemaVersion: 1,
    chipUnit: 1,
    bettingStructure: o.structure ?? 'no_limit',
    legalActions: ['fold', 'call', 'raise', 'all_in'],
    toCall: currentBet - hero.bet,
    minRaiseTo: currentBet * 2,
    maxRaiseTo: heroTotal,
    actionHistory: (o.history ?? []).map((a, i) => ({
      userId: `p${a.seat}`,
      amount: 0,
      timestamp: i,
      stage: 'preflop',
      ...a,
    })),
  };
  return { hero, gs: gs as never };
}

const SHOVE: HorseDecision = { action: 'all_in', thinkTime: 0 };
const open = (seat: number, to: number): Partial<ActionRecord> => ({
  seat,
  action: 'raise',
  amount: to,
  isFullRaise: true,
});

describe('first in: no deep tournament open-shove', () => {
  it('a 35bb UTG stack opens for a size, never all-in', () => {
    const { hero, gs } = table({ heroStack: 35 * BB, oppStack: 35 * BB });
    const d = tournamentShoveDiscipline(SHOVE, hero, gs);
    expect(d.action).toBe('raise');
    expect(d.amount).toBe(220);
  });

  it('holds at every depth from just over the line to 100bb, from every seat', () => {
    for (const depth of [21, 25, 35, 50, 100]) {
      for (const heroSeat of [3, 4, 5, 6, 1]) {
        const { hero, gs } = table({ heroStack: depth * BB, oppStack: depth * BB, heroSeat });
        const d = tournamentShoveDiscipline(SHOVE, hero, gs);
        expect(d.action, `${depth}bb seat ${heroSeat}`).toBe('raise');
        expect(d.amount!, `${depth}bb seat ${heroSeat}`).toBeLessThan(depth * BB * 0.2);
      }
    }
  });

  it('a raise for the whole stack is a shove and gets the same treatment', () => {
    const { hero, gs } = table({ heroStack: 40 * BB, oppStack: 40 * BB });
    const d = tournamentShoveDiscipline(
      { action: 'raise', amount: 40 * BB, thinkTime: 0 },
      hero,
      gs
    );
    expect(d.action).toBe('raise');
    expect(d.amount).toBe(220);
  });

  it(`a genuine short stack still shoves: UTG <= ${TOURNAMENT_EARLY_OPEN_SHOVE_MAX_BB}bb, button <= ${TOURNAMENT_OPEN_SHOVE_MAX_BB}bb`, () => {
    for (const depth of [5, 10, 12]) {
      const { hero, gs } = table({ heroStack: depth * BB, oppStack: 60 * BB });
      expect(tournamentShoveDiscipline(SHOVE, hero, gs)).toBe(SHOVE);
    }
    for (const depth of [5, 15, 20]) {
      const { hero, gs } = table({ heroStack: depth * BB, oppStack: 60 * BB, heroSeat: 6 });
      expect(tournamentShoveDiscipline(SHOVE, hero, gs)).toBe(SHOVE);
    }
  });

  // Dan 2026-10-25, with a screenshot of a 20bb UTG+1 open-shove: "SINCE WHEN
  // IS IT GTO TO OPEN RIP 20BB FROM UTG?!"
  it('the seat sets the line: UTG and the hijack raise from 13bb, the cutoff from 16bb', () => {
    for (const heroSeat of [3, 4]) {
      for (const depth of [13, 15, 20]) {
        const { hero, gs } = table({ heroStack: depth * BB, oppStack: 60 * BB, heroSeat });
        const d = tournamentShoveDiscipline(SHOVE, hero, gs);
        expect(d.action, `seat ${heroSeat} ${depth}bb`).toBe('raise');
        expect(d.amount, `seat ${heroSeat} ${depth}bb`).toBe(220);
      }
    }
    const cutoff = (depth: number) =>
      table({ heroStack: depth * BB, oppStack: 60 * BB, heroSeat: 5 });
    const c15 = cutoff(15);
    expect(tournamentShoveDiscipline(SHOVE, c15.hero, c15.gs)).toBe(SHOVE);
    const c16 = cutoff(16);
    expect(tournamentShoveDiscipline(SHOVE, c16.hero, c16.gs).action).toBe('raise');
    const sb = table({ heroStack: 20 * BB, oppStack: 60 * BB, heroSeat: 1 });
    expect(tournamentShoveDiscipline(SHOVE, sb.hero, sb.gs)).toBe(SHOVE);
  });

  it('depth is EFFECTIVE: a 60bb stack against 10bb stacks raises to exactly what they hold', () => {
    const { hero, gs } = table({ heroStack: 60 * BB, oppStack: 10 * BB });
    const d = tournamentShoveDiscipline(SHOVE, hero, gs);
    expect(d.action).toBe('raise');
    expect(d.amount).toBe(10 * BB);
  });
});

describe('facing a raise: re-raise shoves only where they belong', () => {
  it(`3-bet shove kept at <= ${TOURNAMENT_THREE_BET_SHOVE_MAX_BB}bb`, () => {
    const { hero, gs } = table({
      heroSeat: 6,
      heroStack: 22 * BB,
      oppStack: 22 * BB,
      currentBet: 220,
      bets: { 3: 220 },
      history: [open(3, 220)],
    });
    expect(tournamentShoveDiscipline(SHOVE, hero, gs)).toBe(SHOVE);
  });

  it('AA does not 3-bet shove 60bb over an open: it 3-bets to 3x', () => {
    const { hero, gs } = table({
      heroSeat: 6,
      heroStack: 60 * BB,
      oppStack: 60 * BB,
      currentBet: 220,
      bets: { 3: 220 },
      history: [open(3, 220)],
    });
    const d = tournamentShoveDiscipline(SHOVE, hero, gs);
    expect(d.action).toBe('raise');
    expect(d.amount).toBe(660);
  });

  it(`4-bet shove kept at <= ${TOURNAMENT_FOUR_BET_SHOVE_MAX_BB}bb, sized deeper`, () => {
    const facing3bet = (depth: number) =>
      table({
        heroSeat: 3,
        heroStack: depth * BB,
        oppStack: depth * BB,
        currentBet: 700,
        bets: { 3: 220, 6: 700 },
        history: [open(3, 220), open(6, 700)],
      });
    const shallow = facing3bet(38);
    expect(tournamentShoveDiscipline(SHOVE, shallow.hero, shallow.gs)).toBe(SHOVE);
    const deep = facing3bet(90);
    const d = tournamentShoveDiscipline(SHOVE, deep.hero, deep.gs);
    expect(d.action).toBe('raise');
    expect(d.amount).toBe(1575);
  });

  it('a standard raise that already commits 40% of the stack stays a shove', () => {
    // 30bb facing a 5bb open: 3-bet to 15bb is half the stack.
    const { hero, gs } = table({
      heroSeat: 6,
      heroStack: 30 * BB,
      oppStack: 30 * BB,
      currentBet: 500,
      bets: { 3: 500 },
      history: [open(3, 500)],
    });
    expect(tournamentShoveDiscipline(SHOVE, hero, gs)).toBe(SHOVE);
  });

  it('a 5-bet shove is a 5-bet shove', () => {
    const { hero, gs } = table({
      heroSeat: 6,
      heroStack: 100 * BB,
      oppStack: 100 * BB,
      currentBet: 1600,
      bets: { 3: 1600, 6: 700 },
      history: [open(3, 220), open(6, 700), open(3, 1600)],
    });
    expect(tournamentShoveDiscipline(SHOVE, hero, gs)).toBe(SHOVE);
  });
});

describe('what the rule never touches', () => {
  it('calling a shove is a call, whatever the depth', () => {
    const { hero, gs } = table({ heroSeat: 6, heroStack: 80 * BB });
    const g = gs as unknown as { players: Array<Record<string, unknown>>; currentBet: number };
    for (const p of g.players) {
      if (p.seat === 6) continue;
      if (p.seat === 3) {
        p.is_all_in = true;
        p.bet = 4000;
        p.stack = 0;
      } else p.is_folded = true;
    }
    g.currentBet = 4000;
    expect(tournamentShoveDiscipline(SHOVE, hero, gs)).toBe(SHOVE);
  });

  it('cash games, all-in-or-fold tables and pot limit are untouched', () => {
    for (const o of [
      { gameMode: 'cash' as const },
      { allInOrFold: true },
      { structure: 'pot_limit' as const },
    ]) {
      const { hero, gs } = table({ heroStack: 50 * BB, oppStack: 50 * BB, ...o });
      expect(tournamentShoveDiscipline(SHOVE, hero, gs)).toBe(SHOVE);
    }
  });

  it('a normal raise is untouched', () => {
    const { hero, gs } = table({ heroStack: 50 * BB, oppStack: 50 * BB });
    const raise: HorseDecision = { action: 'raise', amount: 230, thinkTime: 0 };
    expect(tournamentShoveDiscipline(raise, hero, gs)).toBe(raise);
  });
});

describe('the full decision pipeline obeys it', () => {
  it('no 25-100bb tournament stack ever open-shoves, across many hands', () => {
    const holes = ['AsAh', 'KsKd', 'AhKh', 'QsQd', 'JhTh', 'As5s', '9c9d', 'KhQh', '7s7c', 'AdJc'];
    for (const depth of [25, 35, 50, 100]) {
      for (const heroSeat of [3, 4, 5, 6, 1]) {
        for (const hole of holes) {
          const { hero, gs } = table({
            heroStack: depth * BB,
            oppStack: depth * BB,
            heroSeat,
            hole,
          });
          const d = HorseLogic.decide(hero as never, gs, 'balanced', {}, {} as never);
          expect(d.action, `${depth}bb seat ${heroSeat} ${hole}`).not.toBe('all_in');
          if (d.action === 'raise') expect(d.amount!).toBeLessThan(depth * BB - 1);
        }
      }
    }
  });
});
