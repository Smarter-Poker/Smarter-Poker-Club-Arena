/**
 * V51 RIVER FLAT (2026-10-05): a committed river one-pair hand calls instead
 * of jamming.
 *
 * The 2026-10-04 horse audit sampled one_pair_river_stackoff hands at 600bb
 * tournament depth. Hand 1039665 is the clearest: QcJh on 6c 5s Qd 9c 3s, the
 * horse was check-raised on the turn and called, bet 5,629 into 4,255 when
 * the river checked to it, was raised to 15,656 and RE-JAMMED 27,885. The
 * raise left an SPR under 1.2, so the committed branch ran, and that branch
 * answered every hand clearing its call bar with all_in. Replayed through
 * decide() before this change it jammed on 200 of 200 seeds, and so did TT
 * and AA on a board they over-pair.
 *
 * On the river the jam has nothing to deny and only a better hand calls it,
 * so one pair (or two pair where one pair is the board's) now flats. Sets and
 * better keep the jam; earlier streets are untouched.
 */
import { describe, expect, it } from 'vitest';
import { HorseLogic, type HorseGameStateV2 } from './HorseLogic.js';
import { seedFastRandom } from './HorseEval.js';
import { HORSE_DATA_LEDGER } from './HorseDataLedger.js';
import { LEAGUE_MATCHUPS } from '../benchmark/HorseLeague.js';
import type { ActionRecord, Card, SeatPlayer } from '../types.js';

const SUITE_TIMEOUT_MS = 10_000 * (process.env.RUNNER_ENVIRONMENT === 'self-hosted' ? 3 : 1);
const c = (rank: string, suit: string): Card => ({ rank, suit }) as Card;
const H = 'hearts';
const D = 'diamonds';
const S = 'spades';
const C = 'clubs';

interface Spot {
  hole: Card[];
  board: Card[];
}

// Hand 1039665, verbatim.
const QJ_TOP_PAIR: Spot = {
  hole: [c('Q', C), c('J', H)],
  board: [c('6', C), c('5', S), c('Q', D), c('9', C), c('3', S)],
};
const TT_OVERPAIR: Spot = {
  hole: [c('T', C), c('T', S)],
  board: [c('9', D), c('5', H), c('2', C), c('4', D), c('7', H)],
};
const AA_OVERPAIR: Spot = {
  hole: [c('A', C), c('A', S)],
  board: [c('9', D), c('5', H), c('2', C), c('4', D), c('K', H)],
};
// Two pair on paper, one pair in fact: the sevens are the board's.
const QQ_PAIRED_BOARD: Spot = {
  hole: [c('Q', S), c('Q', C)],
  board: [c('8', H), c('7', D), c('5', S), c('7', C), c('J', D)],
};
// A set is not one pair: it keeps the jam.
const SET_OF_NINES: Spot = {
  hole: [c('9', C), c('9', S)],
  board: [c('9', D), c('5', H), c('2', C), c('4', D), c('K', H)],
};

function seat(n: number, cards: Card[], over: Partial<SeatPlayer> = {}): SeatPlayer {
  return {
    seat: n,
    user_id: n === 1 ? 'hero' : `opp${n}`,
    username: n === 1 ? 'hero' : `opp${n}`,
    stack: 0,
    bet: 0,
    totalInvested: 0,
    is_folded: false,
    is_all_in: false,
    is_sitting_out: false,
    is_horse: true,
    cards,
    ...over,
  } as SeatPlayer;
}

/**
 * The river of hand 1039665: 4,255 in the middle, both players started the
 * street with 27,885, hero bet 5,629 and was raised to 15,656.
 */
function raisedOnCommittedRiver(spot: Spot, seed: number, opts: Record<string, unknown>): string {
  seedFastRandom(seed);
  const history = [
    { seat: 1, userId: 'hero', action: 'bet', amount: 301, timestamp: 1, stage: 'turn' },
    { seat: 3, userId: 'opp3', action: 'raise', amount: 1566, timestamp: 2, stage: 'turn' },
    { seat: 1, userId: 'hero', action: 'call', amount: 1265, timestamp: 3, stage: 'turn' },
    { seat: 3, userId: 'opp3', action: 'check', amount: 0, timestamp: 4, stage: 'river' },
    { seat: 1, userId: 'hero', action: 'bet', amount: 5629, timestamp: 5, stage: 'river' },
    { seat: 3, userId: 'opp3', action: 'raise', amount: 15656, timestamp: 6, stage: 'river' },
  ] as ActionRecord[];
  const hero = seat(1, spot.hole, {
    bet: 5629,
    stack: 27885 - 5629,
    totalInvested: 2127 + 5629,
  });
  const gs = {
    players: [hero, seat(3, [], { bet: 15656, stack: 27885 - 15656, totalInvested: 2127 + 15656 })],
    communityCards: spot.board,
    pot: 4255 + 5629 + 15656,
    currentBet: 15656,
    minRaise: 10027,
    lastRaise: 10027,
    stage: 'river',
    gameVariant: 'nlh',
    bigBlind: 50,
    dealerSeat: 3,
    actionHistory: history,
    gameMode: 'cash',
    format: 'cash',
  } as HorseGameStateV2;
  return HorseLogic.decide(hero, gs, 'balanced', {}, { mind: false, ...opts }).action;
}

/** The same raise war one street earlier, with the river still to come. */
function raisedOnCommittedTurn(spot: Spot, seed: number, opts: Record<string, unknown>): string {
  seedFastRandom(seed);
  const history = [
    { seat: 3, userId: 'opp3', action: 'check', amount: 0, timestamp: 1, stage: 'turn' },
    { seat: 1, userId: 'hero', action: 'bet', amount: 5629, timestamp: 2, stage: 'turn' },
    { seat: 3, userId: 'opp3', action: 'raise', amount: 15656, timestamp: 3, stage: 'turn' },
  ] as ActionRecord[];
  const hero = seat(1, spot.hole, { bet: 5629, stack: 27885 - 5629, totalInvested: 2127 + 5629 });
  const gs = {
    players: [hero, seat(3, [], { bet: 15656, stack: 27885 - 15656, totalInvested: 2127 + 15656 })],
    communityCards: spot.board.slice(0, 4),
    pot: 4255 + 5629 + 15656,
    currentBet: 15656,
    minRaise: 10027,
    lastRaise: 10027,
    stage: 'turn',
    gameVariant: 'nlh',
    bigBlind: 50,
    dealerSeat: 3,
    actionHistory: history,
    gameMode: 'cash',
    format: 'cash',
  } as HorseGameStateV2;
  return HorseLogic.decide(hero, gs, 'balanced', {}, { mind: false, ...opts }).action;
}

const SEEDS = Array.from({ length: 60 }, (_, i) => (i + 1) * 977);

describe('V51 river flat, default on', () => {
  it(
    'hand 1039665 (QJ, top pair) calls the river raise and never re-jams',
    () => {
      for (const seed of SEEDS) expect(raisedOnCommittedRiver(QJ_TOP_PAIR, seed, {})).toBe('call');
    },
    SUITE_TIMEOUT_MS
  );

  it(
    'an over-pair is still one pair: TT and AA call, never jam',
    () => {
      for (const spot of [TT_OVERPAIR, AA_OVERPAIR]) {
        for (const seed of SEEDS) {
          expect(raisedOnCommittedRiver(spot, seed, {})).not.toBe('all_in');
        }
      }
    },
    SUITE_TIMEOUT_MS
  );

  it(
    'two pair whose second pair is the board is treated as one pair',
    () => {
      for (const seed of SEEDS) {
        expect(raisedOnCommittedRiver(QQ_PAIRED_BOARD, seed, {})).not.toBe('all_in');
      }
    },
    SUITE_TIMEOUT_MS
  );

  it(
    'a set keeps the jam',
    () => {
      for (const seed of SEEDS) {
        expect(raisedOnCommittedRiver(SET_OF_NINES, seed, {})).toBe('all_in');
      }
    },
    SUITE_TIMEOUT_MS
  );

  it(
    'the turn is untouched: the same raise war plays identically with the flag off',
    () => {
      for (const spot of [QJ_TOP_PAIR, TT_OVERPAIR, AA_OVERPAIR]) {
        for (const seed of SEEDS) {
          expect(raisedOnCommittedTurn(spot, seed, {})).toBe(
            raisedOnCommittedTurn(spot, seed, { v51RiverFlat: false })
          );
        }
      }
    },
    SUITE_TIMEOUT_MS
  );
});

describe('V51 river flat, ablated', () => {
  it(
    'with the flag off the committed branch re-jams one pair, as before',
    () => {
      // The defect this layer fixes, reproduced: if this ever stops jamming,
      // the scenario above no longer reaches the committed branch and the
      // default-on tests prove nothing.
      for (const seed of SEEDS) {
        expect(raisedOnCommittedRiver(QJ_TOP_PAIR, seed, { v51RiverFlat: false })).toBe('all_in');
      }
    },
    SUITE_TIMEOUT_MS
  );
});

describe('V51 wiring', () => {
  it('is registered in the ledger as a flag and a receipt', () => {
    const keys = new Map(HORSE_DATA_LEDGER.map((e) => [e.key, e.kind]));
    expect(keys.get('v51RiverFlat')).toBe('flag');
    expect(keys.get('v51_river_flat')).toBe('receipt');
  });

  it('has a league matchup and is switched off in full_vs_v2_legacy', () => {
    const m = LEAGUE_MATCHUPS.find((x) => x.name === 'v51_river_flat');
    expect(m?.b).toEqual({ v51RiverFlat: false });
    const legacy = LEAGUE_MATCHUPS.find((x) => x.name === 'full_vs_v2_legacy')!.b as Record<
      string,
      unknown
    >;
    expect(legacy.v51RiverFlat).toBe(false);
  });
});
