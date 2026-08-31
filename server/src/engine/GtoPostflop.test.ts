/**
 * V29/V30 — OPEN NODES PLAY FROM THE SOLVER (Dan 2026-08-29).
 *
 * The store semantics, the texture classifier (which must mirror the SQL
 * fn_gto_texture_class / fn_gto_texture_class_any EXACTLY — shared examples
 * classified by the production functions are pinned here), the wiring into
 * HorseLogic across flop/turn/river, the refusal of contaminated 'facing'
 * rows, and the ablation equality that keeps a loader failure from changing
 * poker.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  setGtoPostflop,
  gtoPostflopCount,
  _clearGtoPostflop,
  textureClass,
  snapDepthBucket,
  gtoStreetAdvice,
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

describe('textureClass - the exact mirror of fn_gto_texture_class (3 cards)', () => {
  /**
   * These examples were classified BY THE DATABASE FUNCTION against
   * production and the answers recorded here. If this test disagrees with
   * the SQL, live lookups land in the wrong cell — this is the contract pin.
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

describe('textureClass - the exact mirror of fn_gto_texture_class_any (4/5 cards)', () => {
  /**
   * V30 contract pins: every expected value below is the answer
   * fn_gto_texture_class_any gave IN PRODUCTION on 2026-08-29. The turn and
   * river cells are keyed by these strings; a divergence sends live lookups
   * into the wrong cell.
   */
  const cases: Array<[Card[], string]> = [
    // three hearts on four cards -> flush possible -> t; QJT straighty
    [[H('Q'), D('J'), H('T'), H('2')], 'Btuc'],
    // four hearts on five cards -> m; A high; AKQJT+9 very connected
    [[H('Q'), D('J'), H('T'), H('A'), H('9')], 'Amuc'],
    // paired K, rainbow, dry five-card runout
    [[H('K'), D('K'), CL('7'), S('2'), D('9')], 'Brpd'],
    // four-card rainbow, disconnected
    [[H('2'), D('7'), CL('9'), S('K')], 'Brud'],
    // the same runout with an ace river: A high, still dry
    [[H('2'), D('7'), CL('9'), S('K'), D('A')], 'Arud'],
    // four hearts on four cards -> m; wheel window (A,4,2) -> connected
    [[H('A'), H('K'), H('4'), H('2')], 'Amuc'],
    // JT98 rainbow: M high (J), maximally connected
    [[H('T'), S('9'), D('8'), CL('J')], 'Mruc'],
    // trips 666 + 2: paired (p), only two distinct ranks -> dry
    [[H('6'), D('6'), CL('6'), S('2')], 'Lrpd'],
    // A-2-3 wheel window on a five-card board
    [[H('A'), D('2'), CL('3'), S('9'), S('8')], 'Aruc'],
    // double-paired 5599K: no 3 distinct ranks in any 5-window -> dry
    [[H('5'), D('5'), CL('9'), S('9'), D('K')], 'Brpd'],
    // five diamonds: m, wheel-connected via A-4-2
    [[D('A'), D('K'), D('4'), D('2'), D('9')], 'Amuc'],
    // 2-4-6-8-T: gappy but three ranks always share a 5-window -> connected
    [[CL('2'), D('4'), H('6'), S('8'), D('T')], 'Mruc'],
  ];
  for (const [board, expected] of cases) {
    it(`${board.map((b) => b.rank + b.suit[0]).join('')} -> ${expected}`, () => {
      expect(textureClass(board)).toBe(expected);
    });
  }

  it('refuses a six-card board rather than classifying garbage', () => {
    expect(textureClass([H('A'), H('K'), H('4'), H('2'), D('9'), S('3')])).toBe(null);
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

describe('setGtoPostflop - the store only accepts what is trustworthy', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    street: 'flop',
    game_family: 'cash',
    position: 'BTN',
    depth_bucket: 40,
    texture_class: 'Btuc',
    facing: 'open',
    hand_matrix: { AKs: { check: 1 } },
    ...over,
  });

  it('accepts open cells for all three streets', () => {
    expect(
      setGtoPostflop([row(), row({ street: 'turn' }), row({ street: 'river' })] as never)
    ).toBe(3);
    expect(gtoPostflopCount()).toBe(3);
  });

  /**
   * THE 2026-08-29 LESSON, PINNED. The 'facing' cells were aggregated from
   * deep-tree exports whose fold numbers average 299 — EV contamination, not
   * frequencies — and the layer they fed over-folded live flops. The cells
   * were purged from the DB; this pin keeps a stale snapshot or a restored
   * backup from resurrecting them through the loader.
   */
  it('REFUSES facing cells outright', () => {
    expect(setGtoPostflop([row({ facing: 'facing' })] as never)).toBe(0);
    expect(gtoPostflopCount()).toBe(0);
  });

  it('refuses unknown streets and broken matrices', () => {
    expect(setGtoPostflop([row({ street: 'preflop' })] as never)).toBe(0);
    expect(setGtoPostflop([row({ hand_matrix: null })] as never)).toBe(0);
  });
});

describe('gtoStreetAdvice - lookup semantics', () => {
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
    const a = gtoStreetAdvice({
      street: 'flop',
      family: 'cash',
      position: 'BTN',
      stackBB: 45,
      board: [H('Q'), D('J'), H('T')],
      hand: 'AKs',
    });
    expect(a?.mix).toEqual({ check: 0.1, bet_small: 0.3, bet_big: 0.6 });
  });

  it('streets are separate cells - a flop cell never answers a turn lookup', () => {
    setGtoPostflop([cell()] as never);
    expect(
      gtoStreetAdvice({
        street: 'turn',
        family: 'cash',
        position: 'BTN',
        stackBB: 45,
        board: [H('Q'), D('J'), H('T'), H('2')],
        hand: 'AKs',
      })
    ).toBe(null);
  });

  it('a turn cell answers a turn board via the 4-card texture', () => {
    setGtoPostflop([
      cell({ street: 'turn', hand_matrix: { AKs: { check: 0.4, bet_small: 0.6 } } }),
    ] as never);
    const a = gtoStreetAdvice({
      street: 'turn',
      family: 'cash',
      position: 'BTN',
      stackBB: 45,
      board: [H('Q'), D('J'), H('T'), H('2')], // -> Btuc, production-pinned
      hand: 'AKs',
    });
    expect(a?.mix).toEqual({ check: 0.4, bet_small: 0.6 });
  });

  it('an absent hand is silence, not a fabricated action', () => {
    setGtoPostflop([cell()] as never);
    expect(
      gtoStreetAdvice({
        street: 'flop',
        family: 'cash',
        position: 'BTN',
        stackBB: 45,
        board: [H('Q'), D('J'), H('T')],
        hand: '72o',
      })
    ).toBe(null);
  });

  it('a tournament spot prefers the ICM cell and falls back to chip-EV, never the reverse', () => {
    setGtoPostflop([
      cell({ game_family: 'tourney_ev', hand_matrix: { AKs: { check: 1 } } }),
    ] as never);
    const a = gtoStreetAdvice({
      street: 'flop',
      family: 'tourney_icm',
      position: 'BTN',
      stackBB: 45,
      board: [H('Q'), D('J'), H('T')],
      hand: 'AKs',
    });
    expect(a?.mix).toEqual({ check: 1 });
    // chip-EV never borrows ICM advice (over-folding in a chip-EV spot)
    _clearGtoPostflop();
    setGtoPostflop([
      cell({ game_family: 'tourney_icm', hand_matrix: { AKs: { check: 1 } } }),
    ] as never);
    expect(
      gtoStreetAdvice({
        street: 'flop',
        family: 'tourney_ev',
        position: 'BTN',
        stackBB: 45,
        board: [H('Q'), D('J'), H('T')],
        hand: 'AKs',
      })
    ).toBe(null);
  });

  it('texture is NEVER substituted - a rainbow cell does not answer a monotone board', () => {
    setGtoPostflop([cell({ texture_class: 'Bruc' })] as never);
    expect(
      gtoStreetAdvice({
        street: 'flop',
        family: 'cash',
        position: 'BTN',
        stackBB: 45,
        board: [H('Q'), H('J'), H('T')], // monotone -> Bmuc
        hand: 'AKs',
      })
    ).toBe(null);
  });
});

describe('rollMix - solver frequencies are honored, not rounded', () => {
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

describe('the wiring - HorseLogic consults the open-node cells on every street', () => {
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

  // Turn variant of the same hand: BB check-called the flop bet, then
  // checked the turn to hero — hero still holds the lead.
  const turnHistory: ActionRecord[] = [
    ...history,
    { stage: 'flop', seat: 3, userId: 'hero', action: 'bet', amount: 4, isFullRaise: true },
    { stage: 'flop', seat: 1, userId: 'bb', action: 'call', amount: 4 },
    { stage: 'turn', seat: 1, userId: 'bb', action: 'check', amount: 0 },
  ] as unknown as ActionRecord[];

  const turnGs = (over: Record<string, unknown> = {}) =>
    gs({
      communityCards: [H('Q'), D('J'), H('T'), H('2')],
      stage: 'turn',
      pot: 19,
      actionHistory: turnHistory,
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

  it('V30: a pure-bet TURN cell makes the aggressor stab the turn, sized as a block bet', () => {
    setGtoPostflop([
      {
        street: 'turn',
        game_family: 'cash',
        position: 'SB',
        depth_bucket: 40,
        texture_class: 'Btuc',
        facing: 'open',
        hand_matrix: { AKs: { bet_small: 1 } },
      },
    ] as never);
    for (let i = 0; i < 15; i++) {
      const d = HorseLogic.decide(mkPlayer(), turnGs() as never, 'balanced');
      expect(d.action).toBe('bet');
      // 0.24-0.32 of the 19 pot, before betSize's own rounding — assert the
      // band loosely: a block bet, never a barrel
      expect(d.amount ?? 0).toBeGreaterThan(0);
      expect(d.amount ?? 99).toBeLessThanOrEqual(19 * 0.45);
    }
  });

  it('V30: a pure-check TURN cell checks the same spot, deterministically', () => {
    setGtoPostflop([
      {
        street: 'turn',
        game_family: 'cash',
        position: 'SB',
        depth_bucket: 40,
        texture_class: 'Btuc',
        facing: 'open',
        hand_matrix: { AKs: { check: 1 } },
      },
    ] as never);
    for (let i = 0; i < 15; i++) {
      const d = HorseLogic.decide(mkPlayer(), turnGs() as never, 'balanced');
      expect(d.action).toBe('check');
    }
  });

  /**
   * THE FACING CONSULT IS GONE AND STAYS GONE. Even if a facing row somehow
   * reached setGtoPostflop, it is refused — and a horse facing a bet decides
   * exactly as it would with the solver layer off. (This replaces the old
   * safety-valve test: the premise it guarded — solver facing data — was
   * proven contaminated and purged on 2026-08-29.)
   */
  it('a facing cell cannot influence a facing-a-bet decision', () => {
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
    expect(gtoPostflopCount()).toBe(0);
    const facingGs = gs({
      currentBet: 8,
      pot: 19,
      actionHistory: [
        ...history.slice(0, 2),
        { stage: 'flop', seat: 1, userId: 'bb', action: 'bet', amount: 8 },
      ],
    });
    for (let i = 0; i < 15; i++) {
      const withRow = HorseLogic.decide(mkPlayer(), facingGs as never, 'balanced');
      expect(withRow.action).not.toBe('fold'); // the nut straight never folds here
    }
  });

  /** ABLATION EQUALITY: empty store === layer off, decision for decision. */
  it('an empty store changes nothing - flop and turn', () => {
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

      const onT = HorseLogic.decide(
        mkPlayer({ cards: cards as never }),
        turnGs() as never,
        'balanced',
        {},
        {
          v30GtoTurnRiver: true,
        }
      );
      const offT = HorseLogic.decide(
        mkPlayer({ cards: cards as never }),
        turnGs() as never,
        'balanced',
        {},
        {
          v30GtoTurnRiver: false,
        }
      );
      expect(onT.action).toBe(offT.action);
    }
  });

  it('the loader and the V30 driver are wired at boot', async () => {
    const { readFileSync } = await import('node:fs');
    const idx = readFileSync(new URL('../index.ts', import.meta.url).pathname, 'utf8');
    expect(idx).toContain('startGtoPostflopLoader()');
    expect(idx).toContain('startGtoAggregationDriver()');
  });
});
