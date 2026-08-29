/**
 * V29 — THE FLOP PLAYS FROM THE SOLVER (Dan 2026-08-29, next phase).
 *
 * The store semantics, the texture classifier (which must mirror the SQL
 * fn_gto_texture_class EXACTLY — shared examples pinned here), the wiring
 * into HorseLogic, and the ablation equality that keeps a loader failure
 * from changing poker.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  setGtoPostflop,
  gtoPostflopCount,
  _clearGtoPostflop,
  textureClass,
  snapDepthBucket,
  gtoFlopAdvice,
  rollMix,
} from './GtoPostflop.js';
import { HorseLogic } from './HorseLogic.js';
import type { Card, SeatPlayer, ActionRecord } from '../types.js';

const c = (rank: string, suit: string): Card => ({ rank, suit }) as Card;
const H = (r: string) => c(r, 'hearts');
const D = (r: string) => c(r, 'diamonds');
const S = (r: string) => c(r, 'spades');
const CL = (r: string) => c(r, 'clubs');

beforeEach(() => _clearGtoPostflop());

describe('textureClass — the exact mirror of fn_gto_texture_class', () => {
  /**
   * These examples were classified BY THE DATABASE FUNCTION against
   * production and the answers recorded here. If this test disagrees with
   * the SQL, live lookups land in the wrong cell — this is the contract pin.
   *
   * QhJdTh -> Mtuc (T/J/Q = M? no: hi=Q(12) -> B... verified: 'Btuc')
   */
  const cases: Array<[Card[], string]> = [
    // QhJdTh: hi=Q -> B, two hearts -> t, unpaired, QJT span 2 -> connected
    [[H('Q'), D('J'), H('T')], 'Btuc'],
    // 8h2h3d: hi=8 -> L, two hearts -> t, unpaired, 8-2 span 6 no wheel -> d
    [[H('8'), H('2'), D('3')], 'Ltud'],
    // AhKhQd: A high, two-tone, unpaired, AKQ connected
    [[H('A'), H('K'), D('Q')], 'Atuc'],
    // KhKd7c: B high, rainbow-ish (Kh Kd 7c all differ) -> r, paired, K-7 span 6 -> d
    [[H('K'), D('K'), CL('7')], 'Brpd'],
    // Ah5s4d: A high, rainbow, unpaired, wheel connectivity (A plays low with 5,4)
    [[H('A'), S('5'), D('4')], 'Aruc'],
    // 4h3s2d: L high, rainbow, unpaired, connected
    [[H('4'), S('3'), D('2')], 'Lruc'],
    // Monotone: Ah Th 4h
    [[H('A'), H('T'), H('4')], 'Amud'],
  ];
  for (const [board, expected] of cases) {
    it(`${board.map((b) => b.rank + b.suit[0]).join('')} -> ${expected}`, () => {
      expect(textureClass(board)).toBe(expected);
    });
  }

  it('refuses a short or broken board rather than classifying garbage', () => {
    expect(textureClass([H('A'), H('K')])).toBe(null);
    expect(textureClass([H('A'), H('K'), c('X', 'hearts')])).toBe(null);
  });
});

describe('depth buckets match the aggregation', () => {
  it('snaps onto 10/20/40/80/150 exactly as the SQL cases do', () => {
    expect(snapDepthBucket(8)).toBe(10);
    expect(snapDepthBucket(12)).toBe(10);
    expect(snapDepthBucket(13)).toBe(20);
    expect(snapDepthBucket(30)).toBe(20);
    expect(snapDepthBucket(31)).toBe(40);
    expect(snapDepthBucket(60)).toBe(40);
    expect(snapDepthBucket(61)).toBe(80);
    expect(snapDepthBucket(110)).toBe(80);
    expect(snapDepthBucket(111)).toBe(150);
    expect(snapDepthBucket(Number.NaN)).toBe(40); // unreadable -> middle, never throw
  });
});

describe('gtoFlopAdvice — lookup semantics', () => {
  const cell = (over: Record<string, unknown> = {}) => ({
    street: 'flop',
    game_family: 'cash',
    position: 'BTN',
    depth_bucket: 40,
    texture_class: 'Btuc',
    facing: 'open',
    hand_matrix: {
      AKs: { check: 0.1, bet_small: 0.3, bet_big: 0.6 },
      '55': { check: 0.8, bet_small: 0.2 },
    },
    ...over,
  });

  it('returns the stored mix for a charted hand', () => {
    setGtoPostflop([cell()] as never);
    const a = gtoFlopAdvice({
      family: 'cash',
      position: 'BTN',
      stackBB: 45,
      board: [H('Q'), D('J'), H('T')],
      facing: 'open',
      hand: 'AKs',
    });
    expect(a?.mix).toEqual({ check: 0.1, bet_small: 0.3, bet_big: 0.6 });
  });

  it('an absent hand on an OPEN node is silence, not a fabricated fold — there is no fold option', () => {
    setGtoPostflop([cell()] as never);
    const a = gtoFlopAdvice({
      family: 'cash',
      position: 'BTN',
      stackBB: 45,
      board: [H('Q'), D('J'), H('T')],
      facing: 'open',
      hand: '72o',
    });
    expect(a).toBe(null);
  });

  it('an absent hand on a FACING node is a fold, per the solver output convention', () => {
    setGtoPostflop([cell({ facing: 'facing', hand_matrix: { AKs: { call: 1 } } })] as never);
    const a = gtoFlopAdvice({
      family: 'cash',
      position: 'BTN',
      stackBB: 45,
      board: [H('Q'), D('J'), H('T')],
      facing: 'facing',
      hand: '72o',
    });
    expect(a?.mix).toEqual({ fold: 1 });
  });

  it('a tournament spot prefers the ICM cell and falls back to chip-EV, never the reverse', () => {
    setGtoPostflop([
      cell({ game_family: 'tourney_ev', hand_matrix: { AKs: { check: 1 } } }),
    ] as never);
    const a = gtoFlopAdvice({
      family: 'tourney_icm',
      position: 'BTN',
      stackBB: 45,
      board: [H('Q'), D('J'), H('T')],
      facing: 'open',
      hand: 'AKs',
    });
    expect(a?.mix).toEqual({ check: 1 });
    // chip-EV never borrows ICM advice (over-folding in a chip-EV spot)
    _clearGtoPostflop();
    setGtoPostflop([
      cell({ game_family: 'tourney_icm', hand_matrix: { AKs: { check: 1 } } }),
    ] as never);
    expect(
      gtoFlopAdvice({
        family: 'tourney_ev',
        position: 'BTN',
        stackBB: 45,
        board: [H('Q'), D('J'), H('T')],
        facing: 'open',
        hand: 'AKs',
      })
    ).toBe(null);
  });

  it('texture is NEVER substituted — a rainbow cell does not answer a monotone board', () => {
    setGtoPostflop([cell({ texture_class: 'Bruc' })] as never);
    expect(
      gtoFlopAdvice({
        family: 'cash',
        position: 'BTN',
        stackBB: 45,
        board: [H('Q'), H('J'), H('T')], // monotone -> Bmuc
        facing: 'open',
        hand: 'AKs',
      })
    ).toBe(null);
  });
});

describe('rollMix — solver frequencies are honored, not rounded', () => {
  it('splits ~30/70 over many rolls', () => {
    const mix = { check: 0.3, bet_big: 0.7 };
    let checks = 0;
    let i = 0;
    const rand = () => ((i += 7919) % 1000) / 1000; // deterministic spread
    for (let k = 0; k < 1000; k++) if (rollMix(mix, rand) === 'check') checks++;
    expect(checks).toBeGreaterThan(230);
    expect(checks).toBeLessThan(370);
  });

  it('returns null on an all-zero mix instead of inventing an action', () => {
    expect(rollMix({ check: 0 }, () => 0.5)).toBe(null);
  });
});

describe('the wiring — HorseLogic actually consults the flop cells', () => {
  const mkPlayer = (over: Partial<SeatPlayer> = {}): SeatPlayer =>
    ({
      seat: 3,
      user_id: 'hero',
      stack: 80,
      bet: 0,
      is_folded: false,
      is_sitting_out: false,
      cards: [H('A'), H('K')],
      ...over,
    }) as unknown as SeatPlayer;

  // Hero opened preflop, BB called, BB checked the flop to hero: hero has
  // the lead heads-up — the canonical r:0:c node.
  const history: ActionRecord[] = [
    { stage: 'preflop', seat: 3, userId: 'hero', action: 'raise', amount: 5, isFullRaise: true },
    { stage: 'preflop', seat: 1, userId: 'bb', action: 'call', amount: 5 },
    { stage: 'flop', seat: 1, userId: 'bb', action: 'check', amount: 0 },
  ] as unknown as ActionRecord[];

  const gs = (over: Record<string, unknown> = {}) => ({
    players: [
      mkPlayer(),
      { seat: 1, user_id: 'bb', stack: 200, bet: 0, is_folded: false, cards: [] },
    ],
    communityCards: [H('Q'), D('J'), H('T')],
    pot: 11,
    currentBet: 0,
    minRaise: 2,
    stage: 'flop',
    gameVariant: 'nlh',
    bigBlind: 2,
    dealerSeat: 3,
    actionHistory: history,
    ...over,
  });

  it('a pure-bet cell makes the aggressor bet the flop, deterministically', () => {
    setGtoPostflop([
      {
        street: 'flop',
        game_family: 'cash',
        // heads-up the dealer is the SB — classifyPosition says so, and the
        // live mapping follows it, so the cell must too.
        position: 'SB',
        depth_bucket: 40,
        texture_class: 'Btuc',
        facing: 'open',
        hand_matrix: { AKs: { bet_big: 1 } },
      },
    ] as never);
    for (let i = 0; i < 15; i++) {
      const d = HorseLogic.decide(mkPlayer(), gs() as never, 'balanced');
      expect(d.action).toBe('bet');
    }
  });

  it('a pure-check cell makes the same spot check, deterministically', () => {
    setGtoPostflop([
      {
        street: 'flop',
        game_family: 'cash',
        position: 'SB',
        depth_bucket: 40,
        texture_class: 'Btuc',
        facing: 'open',
        hand_matrix: { AKs: { check: 1 } },
      },
    ] as never);
    for (let i = 0; i < 15; i++) {
      const d = HorseLogic.decide(mkPlayer(), gs() as never, 'balanced');
      expect(d.action).toBe('check');
    }
  });

  /**
   * THE SAFETY VALVE. The cell is a texture-class MEAN; the live board can be
   * far better for hero than the class average. A solver 'fold' with the
   * effective nuts is vetoed into a call — the valve prevents folds, never
   * creates them.
   */
  it('a solver fold cannot make the nuts fold', () => {
    setGtoPostflop([
      {
        street: 'flop',
        game_family: 'cash',
        position: 'SB',
        depth_bucket: 40,
        texture_class: 'Btuc',
        facing: 'facing',
        hand_matrix: { AKs: { fold: 1 } },
      },
    ] as never);
    // AhKh on QhJhTh-ish... use QJT two-tone: hero has the royal-draw nut
    // straight — equity is overwhelming.
    const facingGs = gs({
      currentBet: 8,
      pot: 19,
      actionHistory: [
        ...history.slice(0, 2),
        { stage: 'flop', seat: 1, userId: 'bb', action: 'bet', amount: 8 },
      ],
    });
    let folds = 0;
    for (let i = 0; i < 15; i++) {
      const d = HorseLogic.decide(mkPlayer(), facingGs as never, 'balanced');
      if (d.action === 'fold') folds++;
    }
    expect(folds).toBe(0);
  });

  /** ABLATION EQUALITY: empty store === layer off, decision for decision. */
  it('an empty store changes nothing', () => {
    _clearGtoPostflop();
    expect(gtoPostflopCount()).toBe(0);
    for (const cards of [
      [H('A'), H('K')],
      [D('7'), CL('2')],
      [S('9'), S('8')],
    ]) {
      const on = HorseLogic.decide(
        mkPlayer({ cards: cards as never }),
        gs() as never,
        'balanced',
        {},
        {
          v29GtoFlop: true,
        }
      );
      const off = HorseLogic.decide(
        mkPlayer({ cards: cards as never }),
        gs() as never,
        'balanced',
        {},
        {
          v29GtoFlop: false,
        }
      );
      expect(on.action).toBe(off.action);
    }
  });

  it('the loader is wired at boot', async () => {
    const { readFileSync } = await import('node:fs');
    const idx = readFileSync(new URL('../index.ts', import.meta.url).pathname, 'utf8');
    expect(idx).toContain('startGtoPostflopLoader()');
  });
});
