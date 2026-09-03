/**
 * V26 — THE PRIZE LANDSCAPE (Dan 2026-08-28)
 *
 * "Horses should be able to see and have access to the prizes, and which
 *  bounties are left still, if top prizes are gone, or still there - that
 *  changes play."
 *
 * It changes it more than any other tournament read. Busting somebody in a
 * mystery bounty draws a CHEST from a shrinking inventory: while the big ones
 * are still in the box every elimination is a lottery ticket worth far more
 * than its average, and once they are claimed the same bust pays scraps and
 * the event quietly becomes a freezeout. Before this the brain only knew
 * bountyFactor - the share of the PRIZE POOL sitting in bounties - which is a
 * property of the structure and never changes all night, no matter how many
 * chests are gone.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { HorseLogic } from './HorseLogic.js';
import { seedFastRandom } from './HorseEval.js';
import { deriveBountyLandscape, type ChestRow } from '../services/TournamentBrainContext.js';
import type { Card, SeatPlayer, ActionRecord, HandStage } from '../types.js';

beforeEach(() => seedFastRandom(0x5eed26));

function c(spec: string): Card {
  const suitMap: Record<string, Card['suit']> = {
    h: 'hearts',
    d: 'diamonds',
    c: 'clubs',
    s: 'spades',
  };
  return { rank: spec[0] as Card['rank'], suit: suitMap[spec[1]] };
}
const cc = (...specs: string[]): Card[] => specs.map(c);

function mkPlayer(seat: number, overrides: Partial<SeatPlayer> = {}): SeatPlayer {
  return {
    seat,
    user_id: `horse-${seat}`,
    username: `Horse${seat}`,
    stack: 10000,
    bet: 0,
    totalInvested: 0,
    cards: [],
    is_folded: false,
    is_all_in: false,
    is_sitting_out: false,
    is_horse: true,
    ...overrides,
  } as SeatPlayer;
}

type GS = Parameters<(typeof HorseLogic)['decide']>[1];

// ─────────────────────────────────────────────────────────────────────────────
// The inventory read (pure)
// ─────────────────────────────────────────────────────────────────────────────

describe('deriveBountyLandscape', () => {
  const chests = (rows: Array<[string, number]>): ChestRow[] =>
    rows.map(([status, amount_cents]) => ({ status, amount_cents }));

  it('counts only what is still AVAILABLE', () => {
    const l = deriveBountyLandscape(
      chests([
        ['available', 1000],
        ['available', 3000],
        ['paid', 50000],
        ['revealed', 20000],
        ['reserved', 4000],
      ])
    );
    expect(l.mysteryChestsLeft).toBe(2);
    expect(l.mysteryMeanCents).toBe(2000);
    expect(l.mysteryTopCents).toBe(3000);
  });

  it('knows when the TOP prize is gone - the read Dan asked for', () => {
    const claimed = deriveBountyLandscape(
      chests([
        ['paid', 100000], // the big one, already won
        ['available', 2000],
        ['available', 3000],
      ])
    );
    expect(claimed.mysteryTopLive).toBe(false);

    const live = deriveBountyLandscape(
      chests([
        ['available', 100000], // still in the box
        ['available', 2000],
      ])
    );
    expect(live.mysteryTopLive).toBe(true);
  });

  it('an exhausted inventory reports zero, not a phantom jackpot', () => {
    const l = deriveBountyLandscape(
      chests([
        ['paid', 5000],
        ['paid', 9000],
      ])
    );
    expect(l.mysteryChestsLeft).toBe(0);
    expect(l.mysteryMeanCents).toBe(0);
    expect(l.mysteryTopLive).toBe(false);
  });

  it('VOID chests were never in play and are ignored entirely', () => {
    // A voided chest must not make the top prize look claimed - it was
    // withdrawn, not won.
    const l = deriveBountyLandscape(
      chests([
        ['void', 999999],
        ['available', 5000],
      ])
    );
    expect(l.mysteryChestsLeft).toBe(1);
    expect(l.mysteryTopLive).toBe(true);
  });

  it('no chest system at all degrades to zeros', () => {
    expect(deriveBountyLandscape([]).mysteryChestsLeft).toBe(0);
    expect(deriveBountyLandscape(null).mysteryTopLive).toBe(false);
    expect(deriveBountyLandscape(undefined).mysteryMeanCents).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The landscape reaches the decision
// ─────────────────────────────────────────────────────────────────────────────

/** Hero covers the raiser; a marginal PLO hand; the landscape varies. */
function bountySpot(tournament: Record<string, unknown>): { hero: SeatPlayer; gs: GS } {
  const hero = mkPlayer(1, { cards: cc('Ah', 'Kd', '9h', '6c'), stack: 12000, bet: 0 });
  const players = [hero, mkPlayer(2, { stack: 3000, bet: 350 }), mkPlayer(3)];
  const gs = {
    players,
    communityCards: [] as Card[],
    pot: 500,
    currentBet: 350,
    minRaise: 350,
    stage: 'preflop' as HandStage,
    gameVariant: 'plo4',
    bigBlind: 100,
    dealerSeat: 3,
    gameMode: 'tournament' as const,
    format: 'mtt' as const,
    ante: 12.5,
    tournament: {
      playersLeft: 40,
      spotsPaid: 20,
      bountyFactor: 0.5,
      ...tournament,
    },
    actionHistory: [
      {
        seat: 2,
        userId: 'horse-2',
        action: 'raise' as const,
        amount: 350,
        timestamp: 1,
        stage: 'preflop' as HandStage,
        isFullRaise: true,
      } as ActionRecord,
    ],
  } as unknown as GS;
  return { hero, gs };
}

/** Does the horse put money in against the covered raiser? */
function playsBack(tournament: Record<string, unknown>, opts = {}): boolean {
  seedFastRandom(0x5eed26);
  const { hero, gs } = bountySpot(tournament);
  const d = HorseLogic.decide(hero, gs, 'balanced', {}, { mind: false, ...opts });
  return d.action !== 'fold';
}

describe('V26 the landscape changes play', () => {
  it('a LIVE top prize is chased harder than a depleted inventory', () => {
    // Same hand, same price, same opponent - only the box differs.
    const live = playsBack({
      mysteryChestsLeft: 40,
      mysteryMeanCents: 5000,
      mysteryTopCents: 500000,
      mysteryTopLive: true,
    });
    const exhausted = playsBack({
      mysteryChestsLeft: 0,
      mysteryMeanCents: 0,
      mysteryTopCents: 500000,
      mysteryTopLive: false,
    });
    // The live jackpot must be at least as attractive as the empty box, and
    // the flat bountyFactor alone could never tell these two apart.
    expect(live || !exhausted).toBe(true);
  });

  it('an exhausted inventory is priced as the freezeout it has become', () => {
    // bountyFactor still says 0.5 - the structure has not changed - but every
    // chest is claimed, so the bounty half of the event is over.
    const { hero, gs } = bountySpot({
      mysteryChestsLeft: 0,
      mysteryMeanCents: 0,
      mysteryTopCents: 500000,
      mysteryTopLive: false,
    });
    const withV26 = HorseLogic.decide(hero, gs, 'balanced', {}, { mind: false });
    seedFastRandom(0x5eed26);
    const withoutV26 = HorseLogic.decide(
      hero,
      gs,
      'balanced',
      {},
      { mind: false, v26Prizes: false }
    );
    // V26 can only ever be MORE conservative here than the flat pool ratio.
    const loose = (a: string) => (a === 'fold' ? 0 : 1);
    expect(loose(withV26.action)).toBeLessThanOrEqual(loose(withoutV26.action));
  });

  it('a freezeout with no chest system behaves exactly as before', () => {
    const { hero, gs } = bountySpot({ bountyFactor: 0 });
    const a = HorseLogic.decide(hero, gs, 'balanced', {}, { mind: false });
    seedFastRandom(0x5eed26);
    const b = HorseLogic.decide(hero, gs, 'balanced', {}, { mind: false, v26Prizes: false });
    expect(a.action).toBe(b.action);
  });

  it('a cash game is untouched - no tournament, no landscape', () => {
    const hero = mkPlayer(1, { cards: cc('Ah', 'Kd', '9h', '6c'), stack: 12000 });
    const gs = {
      players: [hero, mkPlayer(2, { bet: 350 })],
      communityCards: [] as Card[],
      pot: 500,
      currentBet: 350,
      minRaise: 350,
      stage: 'preflop' as HandStage,
      gameVariant: 'plo4',
      bigBlind: 100,
      dealerSeat: 2,
      gameMode: 'cash' as const,
      actionHistory: [] as ActionRecord[],
    } as unknown as GS;
    const a = HorseLogic.decide(hero, gs, 'balanced', {}, { mind: false });
    seedFastRandom(0x5eed26);
    const b = HorseLogic.decide(hero, gs, 'balanced', {}, { mind: false, v26Prizes: false });
    expect(a.action).toBe(b.action);
  });
});
