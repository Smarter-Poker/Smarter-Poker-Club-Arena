/**
 * V39 — the bet thinks about the next card (2026-09-03).
 *
 * Dan: "AFTER THEY MAKE A PLAY, THEY SHOULD ALREADY BE STARTING TO THINK
 * ABOUT WHAT PLAY THEY WILL MAKE IF THEY GET CALLED OR RAISED, OR WHAT ARE
 * 'GOOD CARDS' OR 'BAD CARDS' ON THE NEXT STREET."
 *
 * The raise-response plan (V23: commit / call once / fold to a raise) already
 * existed. This adds the next-card outlook: at bet time every unseen card is
 * classified good / scare / blank for hero, and the next street reads the
 * card that came against that record.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { nextCardOutlook, variantInfo, seedFastRandom } from './HorseEval.js';
import { HorseMind } from './HorseMind.js';
import { HorseLogic } from './HorseLogic.js';
import { enableBrainTelemetry, drainFires } from './BrainTelemetry.js';
import type { Card, CardRank, CardSuit, SeatPlayer, ActionRecord } from '../types.js';

const S: Record<string, CardSuit> = { c: 'clubs', d: 'diamonds', h: 'hearts', s: 'spades' };
const cd = (t: string): Card[] => {
  const o: Card[] = [];
  for (let i = 0; i + 1 < t.length; i += 2) o.push({ rank: t[i] as CardRank, suit: S[t[i + 1]] });
  return o;
};
const fires = () => Object.fromEntries(drainFires().map((r) => [r.feature, r.fires]));

describe('V39 nextCardOutlook', () => {
  it('a flush draw: its suit is good, a third card of the other two-tone suit is a scare', () => {
    // hero Ah Kh on Qh 7h 2c: hearts improve; clubs bring nothing scary yet
    const o = nextCardOutlook(cd('AhKh'), cd('Qh7h2c'), variantInfo('nlh'));
    expect(o.madeNow).toBe(1);
    expect(o.good).toContain('3h');
    expect(o.good).toContain('Ad'); // top pair arrives
    expect(o.good).not.toContain('3c');
    expect(o.scare).toHaveLength(0);
  });

  it('a made straight: a third flush card hero lacks and a board pair are scares', () => {
    // hero 9c 8c on 7h 6h 5d: straight now; hearts scare; board pairs scare
    const o = nextCardOutlook(cd('9c8c'), cd('7h6h5d'), variantInfo('nlh'));
    expect(o.madeNow).toBe(5);
    expect(o.scare).toContain('Ah');
    expect(o.scare).toContain('7d');
    expect(o.good).not.toContain('Ah');
  });

  it('holding the flush blocker, the flush card is not a scare', () => {
    const o = nextCardOutlook(cd('9h8c'), cd('7h6h5d'), variantInfo('nlh'));
    expect(o.scare).not.toContain('Ah');
  });

  it('is silent on the river and before the flop', () => {
    expect(nextCardOutlook(cd('AhKh'), cd('Qh7h2c3d9s'), variantInfo('nlh')).good).toHaveLength(0);
    expect(nextCardOutlook(cd('AhKh'), [], variantInfo('nlh')).good).toHaveLength(0);
  });

  it('Omaha: two of the suit are needed to hold the flush, one is not a blocker', () => {
    const o = nextCardOutlook(cd('Ah9c8c7d'), cd('Qh7h2c'), variantInfo('plo4'));
    // hero has one heart: a third heart is still a scare in Omaha
    expect(o.scare).toContain('3h');
  });
});

describe('V39 the plan store', () => {
  beforeEach(() => HorseMind.reset());
  it('records an outlook per (hand, player, street) and reads the card that came', () => {
    HorseMind.noteOutlook('h1', 'u', 'flop', ['3h', 'Ad'], ['Ac']);
    expect(HorseMind.outlookOf('h1', 'u', 'flop', '3h')).toBe('good');
    expect(HorseMind.outlookOf('h1', 'u', 'flop', 'Ac')).toBe('scare');
    expect(HorseMind.outlookOf('h1', 'u', 'flop', '2d')).toBe('blank');
    expect(HorseMind.outlookOf('h1', 'u', 'turn', '3h')).toBeUndefined();
    expect(HorseMind.outlookOf(null, 'u', 'flop', '3h')).toBeUndefined();
  });
});

describe('V39 wiring: a semi-bluff bet writes the outlook; the turn reads it', () => {
  beforeEach(() => {
    seedFastRandom(0x5eed39);
    HorseMind.reset();
    enableBrainTelemetry();
    drainFires();
  });
  const mk = (board: string, history: ActionRecord[], stage: 'flop' | 'turn') => {
    const players: SeatPlayer[] = [
      {
        seat: 1,
        user_id: 'villain',
        username: 'v',
        stack: 380,
        bet: 0,
        totalInvested: 20,
        cards: [],
        is_folded: false,
        is_all_in: false,
        is_sitting_out: false,
      },
      {
        seat: 2,
        user_id: 'hero',
        username: 'h',
        stack: 380,
        bet: 0,
        totalInvested: 20,
        cards: cd('Jh9h'),
        is_folded: false,
        is_all_in: false,
        is_sitting_out: false,
      },
    ];
    return {
      hero: players[1],
      gs: {
        players,
        communityCards: cd(board),
        pot: 40,
        currentBet: 0,
        minRaise: 2,
        stage,
        gameVariant: 'nlh',
        gameMode: 'cash',
        bigBlind: 2,
        dealerSeat: 2,
        actionHistory: history,
      },
    };
  };
  it('a flop bet with a draw records the outlook and the turn consults it', () => {
    const pre: ActionRecord[] = [
      { seat: 2, userId: 'hero', action: 'raise', amount: 6, timestamp: 1, stage: 'preflop' },
      { seat: 1, userId: 'villain', action: 'call', amount: 4, timestamp: 2, stage: 'preflop' },
      { seat: 1, userId: 'villain', action: 'check', amount: 0, timestamp: 3, stage: 'flop' },
    ];
    let recorded = 0;
    let consulted = 0;
    for (let i = 0; i < 40; i++) {
      HorseMind.reset();
      drainFires();
      const flop = mk('Qh7h2c', pre, 'flop');
      const d = HorseLogic.decide(flop.hero, flop.gs as never, 'lag', {}, { telemetry: true });
      const f1 = fires();
      if (f1['v39_outlook_recorded']) recorded++;
      if (d.action !== 'bet') continue;
      const turnHist: ActionRecord[] = [
        ...pre,
        {
          seat: 2,
          userId: 'hero',
          action: 'bet',
          amount: d.amount ?? 14,
          timestamp: 4,
          stage: 'flop',
        },
        {
          seat: 1,
          userId: 'villain',
          action: 'call',
          amount: d.amount ?? 14,
          timestamp: 5,
          stage: 'flop',
        },
        { seat: 1, userId: 'villain', action: 'check', amount: 0, timestamp: 6, stage: 'turn' },
      ];
      const turn = mk('Qh7h2c3h', turnHist, 'turn');
      turn.gs.pot = 40 + 2 * (d.amount ?? 14);
      HorseLogic.decide(turn.hero, turn.gs as never, 'lag', {}, { telemetry: true });
      const f2 = fires();
      if (f2['v39_outlook_good']) consulted++;
    }
    expect(recorded).toBeGreaterThan(0);
    expect(consulted).toBeGreaterThan(0);
  });
});
