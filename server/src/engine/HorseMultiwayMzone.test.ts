/**
 * V20 — MULTIWAY DISCIPLINE + TOURNAMENT M-ZONES (Dan 2026-08-27)
 *
 * Scenario 1 is the hand Dan watched: a horse called off 1000 chips in a cash
 * game with T8o on 779-8 — two pair made of one hole card plus the board's
 * pair — into a check-raise and TWO all-ins. The MC prices opponents by
 * ranges that cannot see the line; V20 caps the equity USED by the structural
 * pressure (raise chains, serious all-ins) and finally makes the committed
 * flat-call bar respect the field and the all-in count.
 *
 * The M-zone scenarios pin the tournament layer: effective M computed from
 * the real orbit cost (blinds + antes), red-zone jam-or-fold, orange-zone
 * open-jams (no raise-fold), and Omaha short stacks finally owning a
 * jam-or-fold posture.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { HorseLogic } from './HorseLogic.js';
import { seedFastRandom } from './HorseEval.js';
import type { Card, SeatPlayer, ActionRecord, HandStage } from '../types.js';
import { LEAGUE_MATCHUPS } from '../benchmark/HorseLeague.js';

beforeEach(() => seedFastRandom(0x5eed20));

function c(spec: string): Card {
  const suitMap: Record<string, Card['suit']> = {
    h: 'hearts',
    d: 'diamonds',
    c: 'clubs',
    s: 'spades',
  };
  return { rank: spec[0] as Card['rank'], suit: suitMap[spec[1]] };
}

function mkPlayer(seat: number, overrides: Partial<SeatPlayer> = {}): SeatPlayer {
  return {
    seat,
    user_id: `horse-${seat}`,
    username: `Horse${seat}`,
    stack: 1000,
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

function rec(
  seat: number,
  action: ActionRecord['action'],
  amount: number,
  stage: HandStage,
  extra: Partial<ActionRecord> = {}
): ActionRecord {
  return {
    seat,
    userId: `horse-${seat}`,
    action,
    amount,
    timestamp: Date.now(),
    stage,
    ...extra,
  };
}

type GS = Parameters<(typeof HorseLogic)['decide']>[1];

// ─────────────────────────────────────────────────────────────────────────────
// The T8o hand — multiway all-in discipline
// ─────────────────────────────────────────────────────────────────────────────

/** Dan's hand: hero T8o, board 779-8, facing a check-raised pot where two
 *  players are ALL IN. The original bettor folded to the jams, so hero
 *  closes the action against exactly the two all-in ranges. */
function dansHand(): { hero: SeatPlayer; gs: GS } {
  const hero = mkPlayer(1, { cards: [c('Td'), c('8c')], stack: 1000, bet: 0 });
  const players = [
    hero,
    mkPlayer(2, { bet: 60, is_folded: true }), // turn bettor, folded to the jams
    mkPlayer(3, { bet: 950, stack: 0, is_all_in: true }), // the check-raise jam
    mkPlayer(4, { bet: 1000, stack: 0, is_all_in: true }),
    mkPlayer(5, { is_folded: true }),
    mkPlayer(6, { is_folded: true }),
  ];
  const gs = {
    players,
    communityCards: [c('7s'), c('7h'), c('9d'), c('8h')],
    pot: 2310,
    currentBet: 1000,
    minRaise: 800,
    stage: 'turn' as HandStage,
    gameVariant: 'nlh',
    bigBlind: 5,
    dealerSeat: 6,
    gameMode: 'cash' as const,
    actionHistory: [
      rec(3, 'check', 0, 'turn'),
      rec(2, 'bet', 60, 'turn'),
      rec(3, 'all_in', 950, 'turn', { isFullRaise: true }),
      rec(4, 'all_in', 1000, 'turn', { isFullRaise: true }),
      rec(2, 'fold', 0, 'turn'),
    ],
  } as unknown as GS;
  return { hero, gs };
}

describe('V20 multiway discipline - the T8o call-off', () => {
  it('FOLDS weak two pair into a check-raise jam plus a second all-in', () => {
    const { hero, gs } = dansHand();
    const d = HorseLogic.decide(hero, gs, 'balanced', {}, { mind: false });
    expect(d.action).toBe('fold');
  });

  it('the fold is the LAYER, not the fixture: v20Multiway off reverts to the leak', () => {
    seedFastRandom(0x5eed20);
    const { hero, gs } = dansHand();
    const d = HorseLogic.decide(hero, gs, 'balanced', {}, { mind: false, v20Multiway: false });
    // The pre-V20 brain paid this off — potOdds + 0.02 was the whole bar.
    expect(d.action).not.toBe('fold');
  });

  it('still defends the same hand against a single ordinary bet', () => {
    const hero = mkPlayer(1, { cards: [c('Td'), c('8c')], stack: 1000, bet: 0 });
    const players = [hero, mkPlayer(2, { bet: 100 }), mkPlayer(3, { is_folded: true })];
    const gs = {
      players,
      communityCards: [c('7s'), c('7h'), c('9d'), c('8h')],
      pot: 300,
      currentBet: 100,
      minRaise: 100,
      stage: 'turn' as HandStage,
      gameVariant: 'nlh',
      bigBlind: 5,
      dealerSeat: 1,
      gameMode: 'cash' as const,
      actionHistory: [rec(2, 'bet', 100, 'turn')],
    } as unknown as GS;
    const d = HorseLogic.decide(hero, gs, 'balanced', {}, { mind: false });
    expect(d.action).not.toBe('fold');
  });

  it('a SET is exempt from the pressure cap - bottom set still stacks off', () => {
    const hero = mkPlayer(1, { cards: [c('2c'), c('2d')], stack: 800, bet: 0 });
    const players = [
      hero,
      mkPlayer(2, { bet: 100 }),
      mkPlayer(3, { bet: 800, stack: 0, is_all_in: true }),
    ];
    const gs = {
      players,
      communityCards: [c('As'), c('7h'), c('2h'), c('Kd')],
      pot: 1200,
      currentBet: 800,
      minRaise: 700,
      stage: 'turn' as HandStage,
      gameVariant: 'nlh',
      bigBlind: 5,
      dealerSeat: 1,
      gameMode: 'cash' as const,
      actionHistory: [
        rec(2, 'bet', 100, 'turn'),
        rec(3, 'all_in', 800, 'turn', { isFullRaise: true }),
      ],
    } as unknown as GS;
    const d = HorseLogic.decide(hero, gs, 'balanced', {}, { mind: false });
    expect(d.action).not.toBe('fold');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tournament M-zones
// ─────────────────────────────────────────────────────────────────────────────

/** 8-handed tournament, ante in play, hero on the button, unopened pot. */
function tourneySpot(
  stackBB: number,
  cards: Card[],
  variant = 'nlh'
): { hero: SeatPlayer; gs: GS } {
  const bb = 100;
  const hero = mkPlayer(1, { cards, stack: stackBB * bb, bet: 0 });
  const players = [hero];
  for (let s = 2; s <= 8; s++) {
    players.push(
      mkPlayer(s, {
        stack: 30 * bb,
        bet: s === 2 ? 50 : s === 3 ? 100 : 0, // SB / BB posted
      })
    );
  }
  const gs = {
    players,
    communityCards: [] as Card[],
    pot: 250, // blinds + antes
    currentBet: bb,
    minRaise: bb,
    stage: 'preflop' as HandStage,
    gameVariant: variant,
    bigBlind: bb,
    dealerSeat: 1, // hero is the button — late position
    gameMode: 'tournament' as const,
    ante: 12.5, // 0.125bb per player -> orbit cost 2.5bb at 8-handed
    actionHistory: [] as ActionRecord[],
  } as unknown as GS;
  return { hero, gs };
}

describe('V20 tournament M-zones', () => {
  it('red zone (M<5): 14bb with a real ante open-jams the button', () => {
    // 14bb reads "not push/fold" to the old stackBB<=12 gate, but the orbit
    // costs 2.5bb — effective M ~4.5. That stack has one move.
    const { hero, gs } = tourneySpot(14, [c('Ah'), c('5h')]);
    const d = HorseLogic.decide(hero, gs, 'balanced', {}, { mind: false });
    expect(d.action).toBe('all_in');
  });

  it('the jam is the LAYER: v20Mzone off treats 14bb as a normal open stack', () => {
    seedFastRandom(0x5eed20);
    const { hero, gs } = tourneySpot(14, [c('Ah'), c('5h')]);
    const d = HorseLogic.decide(hero, gs, 'balanced', {}, { mind: false, v20Mzone: false });
    expect(d.action).not.toBe('all_in');
  });

  it('orange zone (M 6-10): the opening range open-jams instead of raise-folding', () => {
    const { hero, gs } = tourneySpot(22, [c('Ah'), c('Th')]);
    const d = HorseLogic.decide(hero, gs, 'balanced', {}, { mind: false });
    expect(d.action).toBe('all_in');
  });

  it('green zone: a 60bb stack with the same ante still plays normal poker', () => {
    const { hero, gs } = tourneySpot(60, [c('Ah'), c('Th')]);
    const d = HorseLogic.decide(hero, gs, 'balanced', {}, { mind: false });
    expect(d.action).not.toBe('all_in');
  });

  it('Omaha short stacks finally have a jam: 7bb plo4 AAxx facing an open ships it', () => {
    // Unopened, a pot-limit 7bb stack cannot legally jam (max bet = pot) —
    // but FACING an open the reshove is legal, and the old brain had no
    // short-stack posture in Omaha at all.
    const { hero, gs } = tourneySpot(7, [c('Ah'), c('Ad'), c('Kh'), c('Td')], 'plo4');
    (gs as { currentBet: number; pot: number }).currentBet = 300;
    (gs as { currentBet: number; pot: number }).pot = 550;
    (gs.players as SeatPlayer[])[3].bet = 300; // seat 4 opened to 3bb
    (gs.actionHistory as ActionRecord[]).push(
      rec(4, 'raise', 300, 'preflop', { isFullRaise: true })
    );
    const d = HorseLogic.decide(hero, gs, 'balanced', {}, { mind: false });
    expect(d.action).toBe('all_in');
  });

  it('cash games are untouched: 14bb cash button does not become a jam-bot', () => {
    const { hero, gs } = tourneySpot(14, [c('Ah'), c('5h')]);
    (gs as { gameMode: string }).gameMode = 'cash';
    (gs as { ante?: number }).ante = 0;
    const d = HorseLogic.decide(hero, gs, 'balanced', {}, { mind: false });
    // 14bb cash is not in the legacy push/fold gate either (stackBB > 12);
    // whatever it does, the M-zone jam must not fire without a tournament.
    expect(d.action).not.toBe('all_in');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// League card + ablation completeness
// ─────────────────────────────────────────────────────────────────────────────

describe('V20 league registration', () => {
  it('the v20_multiway matchup is on the card', () => {
    const m = LEAGUE_MATCHUPS.find((x) => x.name === 'v20_multiway');
    expect(m).toBeDefined();
    expect(m!.b).toEqual({ v20Multiway: false });
  });

  it('full_vs_v2_legacy disables both V20 flags', () => {
    const legacy = LEAGUE_MATCHUPS.find((x) => x.name === 'full_vs_v2_legacy')!.b as Record<
      string,
      unknown
    >;
    expect(legacy.v20Multiway).toBe(false);
    expect(legacy.v20Mzone).toBe(false);
  });
});
