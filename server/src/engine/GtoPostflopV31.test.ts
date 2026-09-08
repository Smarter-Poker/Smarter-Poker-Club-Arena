/**
 * V31 — the suit-aware solver store (2026-08-30).
 *
 * THE PARITY BLOCK IS THE IMPORTANT ONE. `boardFlushSuit` must agree with
 * `fn_gto_board_flush_suit` in the database exactly, because the cell was
 * KEYED with the SQL function at build time and is READ with the TS one at
 * decision time. If they ever disagree, every lookup on an affected board
 * silently returns another holding's strategy — and a wrong answer is
 * indistinguishable from a right one at the call site. Every expected value
 * below was produced by the production function, including the tie cases.
 *
 * The rest pins the two things that make this layer worth having over V30:
 * the suit bucket actually selecting a different holding, and the bet size
 * coming from the cell rather than a bucket midpoint.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  boardFlushSuit,
  v31HandKey,
  setGtoPostflopV31,
  gtoStreetAdviceV31,
  gtoPostflopV31Count,
  _clearGtoPostflopV31,
  type GtoPostflopV31Row,
} from './GtoPostflopV31.js';
import type { Card, CardRank, CardSuit } from '../types.js';

const SUITS: Record<string, CardSuit> = {
  c: 'clubs',
  d: 'diamonds',
  h: 'hearts',
  s: 'spades',
};

/** '2s9sKdQs' -> Card[]; the same text the SQL function is given. */
function cards(text: string): Card[] {
  const out: Card[] = [];
  for (let i = 0; i + 1 < text.length; i += 2) {
    out.push({ rank: text[i] as CardRank, suit: SUITS[text[i + 1]] });
  }
  return out;
}

beforeEach(() => _clearGtoPostflopV31());

describe('boardFlushSuit - the exact mirror of fn_gto_board_flush_suit', () => {
  // Every pair here was classified by the PRODUCTION function on
  // 2026-08-30. c,d,h,s = 0,1,2,3; -1 means no suit appears twice.
  const PRODUCTION_EXAMPLES: [string, number][] = [
    ['2s9sKdQs', 3], // three spades
    ['2c4hQh', 2], // two hearts
    ['2c4hQd', -1], // rainbow flop
    ['AhKhQh', 2], // monotone hearts
    ['AcAdAh', -1], // trips, three different suits
    ['7d8d9dTd', 1], // four diamonds
    ['2c3d4h5s', -1], // four different suits
    ['KsKdKcKh', -1], // one of every suit
    ['AsKdQhJc9s', 3], // two spades on a five-card board
    ['2h2d2c', -1],
    ['TcTdJhJs', -1], // one of each suit again
    ['3h4h5c6c', 0], // TIE 2-2: the lower suit index wins (clubs)
    ['5c6c7d8h9s', 0], // two clubs
    ['AdKdQdJdTd', 1], // five diamonds
    ['9s9h9d9c2s', 3], // spades twice, everything else once
  ];

  for (const [board, expected] of PRODUCTION_EXAMPLES) {
    it(`${board} -> ${expected}`, () => {
      expect(boardFlushSuit(cards(board))).toBe(expected);
    });
  }

  it('a tie is broken by the LOWEST suit index, exactly as `order by n desc, suit asc` does', () => {
    // clubs(0) and spades(3) both twice -> clubs
    expect(boardFlushSuit(cards('2c3c4s5s'))).toBe(0);
    // diamonds(1) and hearts(2) both twice -> diamonds
    expect(boardFlushSuit(cards('2d3d4h5h'))).toBe(1);
  });

  it('an empty board has no flush suit', () => {
    expect(boardFlushSuit([])).toBe(-1);
  });
});

describe('v31HandKey', () => {
  it('counts how many of the board flush suit the holding contains', () => {
    const board = cards('2s9sKd'); // spades
    expect(v31HandKey('AKs', cards('AsKs'), board)).toBe('AKs:2');
    expect(v31HandKey('AKo', cards('AsKd'), board)).toBe('AKo:1');
    expect(v31HandKey('AKo', cards('AhKd'), board)).toBe('AKo:0');
  });

  it('a board with no flush suit puts every holding in bucket 0 - the plain 169-class cell', () => {
    const rainbow = cards('2c4hQd');
    expect(v31HandKey('AKs', cards('AsKs'), rainbow)).toBe('AKs:0');
    expect(v31HandKey('AKo', cards('AhKd'), rainbow)).toBe('AKo:0');
  });

  it('refuses anything that is not exactly two hole cards', () => {
    expect(v31HandKey('AKs', [], cards('2s9sKd'))).toBeNull();
    expect(v31HandKey('AKs', cards('AsKsQs'), cards('2s9sKd'))).toBeNull();
  });
});

const CELL: GtoPostflopV31Row = {
  street: 'turn',
  game_family: 'cash',
  position: 'BTN',
  depth_bucket: 80,
  // Ks9d7c2h and Ks9s7c2h both classify Brud under the PRODUCTION
  // fn_gto_texture_class_any — the second spade does not change the suit
  // kind on a four-card board (m needs 4+, t needs exactly 3). That is
  // convenient here: one cell serves both, so the only thing that differs
  // between the two lookups below is the FLUSH SUIT.
  texture_class: 'Brud',
  hand_matrix: {
    // the SAME hand class, two suit buckets, opposite strategies — this is
    // the fidelity V30's class-mean averages into a single wrong number
    'AKs:2': { check: 0.0, bet_big: 1.0 },
    'AKs:0': { check: 1.0, bet_big: 0.0 },
    'QQ:0': { check: 0.4, bet_big: 0.6 },
  },
  size_pct: { bet_big: 262 },
};

const BOARD = cards('Ks9d7c2h');

function lookup(hand: string, hole: string) {
  return gtoStreetAdviceV31({
    street: 'turn',
    family: 'cash',
    position: 'BTN',
    stackBB: 80,
    board: BOARD,
    hand,
    holeCards: cards(hole),
  });
}

describe('gtoStreetAdviceV31 - the lookup', () => {
  it('an empty store misses rather than throwing, so the consult falls back', () => {
    const r = gtoStreetAdviceV31({
      street: 'turn',
      family: 'cash',
      position: 'BTN',
      stackBB: 80,
      board: BOARD,
      hand: 'AKs',
      holeCards: cards('AsKs'),
    });
    expect(r.hit).toBe(false);
    if (!r.hit) expect(r.miss).toBe('empty_store');
  });

  it('loads cells and reports its size', () => {
    expect(setGtoPostflopV31([CELL])).toBe(1);
    expect(gtoPostflopV31Count()).toBe(1);
  });

  it('a rainbow board puts every holding in the same bucket', () => {
    setGtoPostflopV31([CELL]);
    const r = lookup('AKs', 'AsKs');
    expect(r.hit).toBe(true);
    if (r.hit) expect(r.cell).toContain('Brud');
  });

  /**
   * THE WHOLE POINT OF THE SUIT DIMENSION: one hand class, two board-relative
   * buckets, opposite strategies. V30 stores a single class-mean here and is
   * therefore wrong for both holdings.
   */
  it('picks the holding the board says it is, not the hand class alone', () => {
    const spadeBoard = cards('Ks9s7c2h'); // two spades, same Brud texture
    setGtoPostflopV31([CELL]);
    const common = {
      street: 'turn' as const,
      family: 'cash' as const,
      position: 'BTN',
      stackBB: 80,
      board: spadeBoard,
      hand: 'AKs',
    };
    const two = gtoStreetAdviceV31({ ...common, holeCards: cards('AsKs') });
    const zero = gtoStreetAdviceV31({ ...common, holeCards: cards('AhKh') });
    expect(two.hit).toBe(true);
    expect(zero.hit).toBe(true);
    if (two.hit && zero.hit) {
      expect(two.mix.bet_big).toBe(1);
      expect(zero.mix.bet_big).toBe(0);
    }
  });

  /**
   * THE SIZE COMES FROM THE CELL. bet_big means ">=110% of pot" and the
   * turn's real mean is 246.8. If this ever returns a bucket midpoint the
   * layer is sizing the solver's overbet at roughly a third of what it is,
   * which is the entire reason V31 exists over V30.
   */
  it('reports the solver size as a pot FRACTION, and it is an overbet', () => {
    setGtoPostflopV31([CELL]);
    const r = lookup('AKs', 'AsKs');
    expect(r.hit).toBe(true);
    if (r.hit) {
      expect(r.sizeFrac.bet_big).toBeCloseTo(2.62, 5);
      expect(r.sizeFrac.bet_big).toBeGreaterThan(1);
    }
  });

  it('a holding the solver never had reports hand_not_in_cell, not a wrong answer', () => {
    setGtoPostflopV31([CELL]);
    const r = lookup('72o', '7h2d');
    expect(r.hit).toBe(false);
    if (!r.hit) expect(r.miss).toBe('hand_not_in_cell');
  });

  it('an uncharted texture reports no_cell - texture is NEVER substituted', () => {
    setGtoPostflopV31([CELL]);
    const r = gtoStreetAdviceV31({
      street: 'turn',
      family: 'cash',
      position: 'BTN',
      stackBB: 80,
      board: cards('KsQs7s2s'),
      hand: 'AKs',
      holeCards: cards('AhKh'),
    });
    expect(r.hit).toBe(false);
    if (!r.hit) expect(r.miss).toBe('no_cell');
  });

  it('a board too short to classify reports no_texture', () => {
    setGtoPostflopV31([CELL]);
    const r = gtoStreetAdviceV31({
      street: 'turn',
      family: 'cash',
      position: 'BTN',
      stackBB: 80,
      board: cards('Ks'),
      hand: 'AKs',
      holeCards: cards('AhKh'),
    });
    expect(r.hit).toBe(false);
    if (!r.hit) expect(r.miss).toBe('no_texture');
  });

  it('an ICM spot falls back to chip-EV - v2 carries no tourney_icm rows at all', () => {
    setGtoPostflopV31([{ ...CELL, game_family: 'tourney_ev' }]);
    const r = gtoStreetAdviceV31({
      street: 'turn',
      family: 'tourney_icm',
      position: 'BTN',
      stackBB: 80,
      board: BOARD,
      hand: 'AKs',
      holeCards: cards('AsKs'),
    });
    expect(r.hit).toBe(true);
    if (r.hit) expect(r.cell).toContain('tourney_ev');
  });

  it('a cell with no recorded size still answers, leaving the caller to fall back', () => {
    setGtoPostflopV31([{ ...CELL, size_pct: null }]);
    const r = lookup('AKs', 'AsKs');
    expect(r.hit).toBe(true);
    if (r.hit) expect(r.sizeFrac.bet_big).toBeUndefined();
  });

  it('refuses a nonsense size rather than betting it', () => {
    setGtoPostflopV31([{ ...CELL, size_pct: { bet_big: 0 } }]);
    const r = lookup('AKs', 'AsKs');
    expect(r.hit).toBe(true);
    if (r.hit) expect(r.sizeFrac.bet_big).toBeUndefined();
  });
});

/**
 * The two properties the V30 suite already establishes as the standard for a
 * solver layer, which Phase 1 shipped without: it must be INERT when it has
 * nothing to say, and it must actually be STARTED at boot. A layer that is
 * wired but never started, or that changes decisions when its table is empty,
 * fails in a way no unit test of the store itself would notice.
 */
describe('the V31 layer is inert when empty, and is wired at boot', () => {
  /**
   * DETERMINISTIC BY CONSTRUCTION, and it has to be. A first attempt compared
   * `decide()` with the layer on against `decide()` with it off and expected
   * the same action. That assertion is INVALID here: HorseLogic.decide draws
   * from shared RNG state, so two sequential calls can differ on their own —
   * observed directly, on=bet off=bet on2=check off2=bet for the same hand.
   * The V30 suite gets away with the same shape only because its spots use a
   * pure cell that forces one action.
   *
   * So this pins the property that actually matters, with no RNG in it: a
   * cell whose mix is 1.0 makes the horse take the solver's action at the
   * solver's OWN size — end to end, lookup through to the chips.
   */
  it('a pure overbet cell makes the horse bet the solver size, not a bucket midpoint', async () => {
    const { HorseLogic } = await import('./HorseLogic.js');
    _clearGtoPostflopV31();
    // QhJdTh2h classifies Btuc with flush suit hearts under the PRODUCTION
    // functions; hero holds AhKh, so the key is AKs:2.
    setGtoPostflopV31([
      {
        street: 'turn',
        game_family: 'cash',
        // heads-up the dealer IS the small blind — classifyPosition says so
        // and the live mapping follows it, so the cell must too. Getting this
        // wrong does not fail loudly: the lookup simply misses and a
        // heuristic answers, which is exactly how this test first "passed"
        // with a pot-sized bet that had nothing to do with the solver.
        position: 'SB',
        depth_bucket: 40,
        texture_class: 'Btuc',
        hand_matrix: { 'AKs:2': { bet_big: 1.0 } },
        size_pct: { bet_big: 262 },
      },
    ]);

    const hero = {
      seat: 3,
      user_id: 'hero',
      // 80 chips at a 2 big blind = 40bb, which snaps to depth bucket 40 and
      // matches the cell. 400 would snap to 150 and the lookup would MISS -
      // and a miss here does not fail loudly, it just lets a heuristic answer.
      stack: 80,
      bet: 0,
      is_folded: false,
      is_sitting_out: false,
      cards: cards('AhKh'),
    };
    const st = {
      players: [hero, { seat: 1, user_id: 'bb', stack: 200, bet: 0, is_folded: false, cards: [] }],
      communityCards: cards('QhJdTh2h'),
      pot: 19,
      currentBet: 0,
      minRaise: 2,
      stage: 'turn',
      gameVariant: 'nlh',
      bigBlind: 2,
      dealerSeat: 3,
      actionHistory: [
        {
          stage: 'preflop',
          seat: 3,
          userId: 'hero',
          action: 'raise',
          amount: 5,
          isFullRaise: true,
        },
        { stage: 'preflop', seat: 1, userId: 'bb', action: 'call', amount: 5 },
        { stage: 'flop', seat: 1, userId: 'bb', action: 'check', amount: 0 },
        { stage: 'flop', seat: 3, userId: 'hero', action: 'bet', amount: 4, isFullRaise: true },
        { stage: 'flop', seat: 1, userId: 'bb', action: 'call', amount: 4 },
        { stage: 'turn', seat: 1, userId: 'bb', action: 'check', amount: 0 },
      ],
    };

    const d = HorseLogic.decide(hero as never, st as never, 'balanced', {}, {} as never);
    expect(d.action).toBe('bet');
    // THE POINT: an OVERBET. A bucket midpoint (~0.7 pot) would be ~13 here;
    // the solver's 262% of a 19 pot is ~50, inside the 80 stack so legalize
    // does not clamp it and the 0.92-of-stack all-in shortcut does not fire.
    expect(d.amount ?? 0).toBeGreaterThan(st.pot);
  });

  it('with an empty store the lookup cannot answer, so the consult falls through', () => {
    _clearGtoPostflopV31();
    expect(gtoPostflopV31Count()).toBe(0);
    const r = gtoStreetAdviceV31({
      street: 'turn',
      family: 'cash',
      position: 'BTN',
      stackBB: 40,
      board: cards('QhJdTh2h'),
      hand: 'AKs',
      holeCards: cards('AhKh'),
    });
    expect(r.hit).toBe(false);
    if (!r.hit) expect(r.miss).toBe('empty_store');
  });

  it('the V31 loader is worker-owned and the V31 driver stays in the leader bootstrap', async () => {
    const { readFileSync } = await import('node:fs');
    const idx = readFileSync(new URL('../index.ts', import.meta.url).pathname, 'utf8');
    const worker = readFileSync(
      new URL('./horseDecision/workerRuntime.ts', import.meta.url).pathname,
      'utf8'
    );
    // Imported and invoked: an import alone is a layer that never runs.
    expect(worker).toContain("from '../../services/GtoPostflopV31Loader.js'");
    expect(worker).toContain('startGtoPostflopV31Loader()');
    expect(idx).toContain("from './services/GtoAggregationDriverV31.js'");
    expect(idx).toContain('startGtoAggregationDriverV31()');
  });

  /**
   * THE ATTRIBUTION MUST NOT LIE. The first version of the consult fired
   * `gto_miss_no_cell` whenever V31 hit but produced no usable action, which
   * claims a cell was absent when one was found. Those counters are the only
   * evidence Phase 3 will have for where the volume goes, so a mislabel is
   * worse than no label. Pinned on the source, because the alternative is
   * asserting on a global telemetry side effect.
   */
  it('never attributes a miss to V31 when V31 actually hit', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('./HorseLogic.ts', import.meta.url).pathname, 'utf8');
    expect(src).toContain('!advice29 && telemetryOn(opts) && v31 && !v31.hit');
    // an unusable hit is counted as its own thing, not as a missing cell
    expect(src).toContain("noteFire('v31_gto_empty_mix')");
    expect(src).toContain("noteFire('v31_gto_no_size')");
    // and an ablated layer must not masquerade as an empty table
    expect(src).toContain(': null;');
  });
});
