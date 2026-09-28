/**
 * V15 BOATS (2026-09-28): an Omaha full house a bigger boat beats is not the
 * nuts.
 *
 * The 2026-09-27 horse audit found two horses RE-RAISING a river raise with an
 * under-full, where the range that raises is the bigger boat:
 *   - hand 759863, plo5: sevens full of kings on 7c 3c 7d 7s 8s (any seven
 *     is quads);
 *   - hand 755677, plo4: tens full of deuces on Tc 2h Ah 2c Qh (AA, QQ and 22
 *     all beat it).
 * Replayed through decide() before this change, both raised or jammed on
 * 73-74% of seeds. V15 treated every `cat >= 7` as nut-class.
 *
 * The change is behind opts.v15Boats, default OFF until the plo5_v15_boats
 * league matchup resolves significant (|bb100| > 2 * stderr).
 */
import { describe, expect, it } from 'vitest';
import { HorseLogic, type HorseGameStateV2 } from './HorseLogic.js';
import { omahaBoatDominated, omahaBoatsAbove, seedFastRandom } from './HorseEval.js';
import type { ActionRecord, Card, SeatPlayer } from '../types.js';

const SUITE_TIMEOUT_MS = 10_000 * (process.env.RUNNER_ENVIRONMENT === 'self-hosted' ? 3 : 1);
const c = (rank: string, suit: string): Card => ({ rank, suit }) as Card;
const H = 'hearts';
const D = 'diamonds';
const S = 'spades';
const C = 'clubs';

const SEVENS_FULL = {
  hole: [c('K', D), c('5', C), c('4', H), c('K', C), c('3', D)],
  board: [c('7', C), c('3', C), c('7', D), c('7', S), c('8', S)],
  variant: 'plo5',
};
const TENS_FULL = {
  hole: [c('T', D), c('T', H), c('J', D), c('5', H)],
  board: [c('T', C), c('2', H), c('A', H), c('2', C), c('Q', H)],
  variant: 'plo4',
};
// Aces full on 9-9: only pocket nines (quads) beat it.
const ACES_FULL = {
  hole: [c('A', D), c('A', S), c('K', D), c('Q', C)],
  board: [c('A', C), c('9', H), c('9', D), c('4', S), c('2', C)],
  variant: 'plo4',
};

function seat(n: number, cards: Card[], over: Partial<SeatPlayer> = {}): SeatPlayer {
  return {
    seat: n,
    user_id: n === 1 ? 'hero' : `opp${n}`,
    username: n === 1 ? 'hero' : `opp${n}`,
    stack: 800,
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

/** River: hero bet 60, the opponent raised to 240. */
function raisedOnRiver(
  spot: { hole: Card[]; board: Card[]; variant: string },
  seed: number,
  opts: Record<string, unknown>
): string {
  seedFastRandom(seed);
  const history = [
    { seat: 1, userId: 'hero', action: 'bet', amount: 60, timestamp: 1, stage: 'river' },
    { seat: 3, userId: 'opp3', action: 'raise', amount: 240, timestamp: 2, stage: 'river' },
  ] as ActionRecord[];
  const hero = seat(1, spot.hole, { bet: 60, stack: 740 });
  const gs = {
    players: [hero, seat(3, [], { bet: 240, stack: 500 })],
    communityCards: spot.board,
    pot: 420,
    currentBet: 240,
    minRaise: 180,
    lastRaise: 180,
    stage: 'river',
    gameVariant: spot.variant,
    bigBlind: 2,
    dealerSeat: 3,
    actionHistory: history,
    gameMode: 'cash',
    format: 'cash',
  } as HorseGameStateV2;
  return HorseLogic.decide(hero, gs, 'balanced', {}, { mind: false, ...opts }).action;
}

/** River: checked to hero, nobody has bet. */
function checkedToOnRiver(
  spot: { hole: Card[]; board: Card[]; variant: string },
  seed: number,
  opts: Record<string, unknown>
): string {
  seedFastRandom(seed);
  const history = [
    { seat: 3, userId: 'opp3', action: 'check', amount: 0, timestamp: 1, stage: 'river' },
  ] as ActionRecord[];
  const hero = seat(1, spot.hole, { stack: 740 });
  const gs = {
    players: [hero, seat(3, [], { stack: 500 })],
    communityCards: spot.board,
    pot: 180,
    currentBet: 0,
    minRaise: 2,
    lastRaise: 0,
    stage: 'river',
    gameVariant: spot.variant,
    bigBlind: 2,
    dealerSeat: 1,
    actionHistory: history,
    gameMode: 'cash',
    format: 'cash',
  } as HorseGameStateV2;
  return HorseLogic.decide(hero, gs, 'balanced', {}, { mind: false, ...opts }).action;
}

const SEEDS = Array.from({ length: 200 }, (_, i) => (i + 1) * 7919);

describe('omahaBoatsAbove', () => {
  it('sevens full on a trips board is beaten by every live seven', () => {
    const b = omahaBoatsAbove(SEVENS_FULL.hole, SEVENS_FULL.board);
    expect(b.quads).toBeGreaterThanOrEqual(2);
    expect(omahaBoatDominated(b)).toBe(true);
  });

  it('tens full of deuces is beaten by bigger boats (AA, QQ)', () => {
    const b = omahaBoatsAbove(TENS_FULL.hole, TENS_FULL.board);
    expect(b.boats).toBe(2);
    expect(omahaBoatDominated(b)).toBe(true);
  });

  it('aces full beaten only by one pocket pair making quads is still the nuts', () => {
    const b = omahaBoatsAbove(ACES_FULL.hole, ACES_FULL.board);
    expect(b).toEqual({ boats: 0, quads: 1 });
    expect(omahaBoatDominated(b)).toBe(false);
  });

  it('a hand that is not a full house has nothing above it', () => {
    const b = omahaBoatsAbove(
      [c('A', S), c('K', S), c('9', D), c('8', C)],
      [c('Q', S), c('J', S), c('4', S), c('7', D), c('2', H)]
    );
    expect(b).toEqual({ boats: 0, quads: 0 });
  });
});

describe('V15 boats, flag on', () => {
  it(
    'a dominated boat raised on the river calls, never re-raises or jams',
    () => {
      for (const spot of [SEVENS_FULL, TENS_FULL]) {
        for (const seed of SEEDS) {
          expect(raisedOnRiver(spot, seed, { v15Boats: true })).toBe('call');
        }
      }
    },
    SUITE_TIMEOUT_MS
  );

  it(
    'the nut boat plays exactly as it did before',
    () => {
      for (const seed of SEEDS) {
        expect(raisedOnRiver(ACES_FULL, seed, { v15Boats: true })).toBe(
          raisedOnRiver(ACES_FULL, seed, {})
        );
      }
    },
    SUITE_TIMEOUT_MS
  );

  it(
    'a dominated boat nobody raised still plays exactly as it did before',
    () => {
      for (const spot of [SEVENS_FULL, TENS_FULL]) {
        for (const seed of SEEDS) {
          expect(checkedToOnRiver(spot, seed, { v15Boats: true })).toBe(
            checkedToOnRiver(spot, seed, {})
          );
        }
      }
    },
    SUITE_TIMEOUT_MS
  );
});

describe('V15 boats is off by default', () => {
  it(
    'with no flag the brain is unchanged: the under-full still re-raises',
    () => {
      let aggressive = 0;
      for (const seed of SEEDS) {
        const a = raisedOnRiver(TENS_FULL, seed, {});
        expect(a).toBe(raisedOnRiver(TENS_FULL, seed, { v15Boats: false }));
        if (a === 'raise' || a === 'all_in') aggressive++;
      }
      // Pins that the default really is off; flip this when the league
      // resolves and the default changes, in the same commit.
      expect(aggressive).toBeGreaterThan(0);
    },
    SUITE_TIMEOUT_MS
  );
});
