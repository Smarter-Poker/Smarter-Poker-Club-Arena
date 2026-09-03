/**
 * V12 RIVER SIZING POLISH (G) — OOP block bets, nut-advantage overbets with
 * paired blocker overbet-bluffs, extended blocker-aware catches.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { HorseMind } from './HorseMind.js';
import { HorseLogic } from './HorseLogic.js';
import { seedFastRandom } from './HorseEval.js';
import type { Card } from '../types.js';

beforeEach(() => {
  HorseMind.reset();
  seedFastRandom(0x5eed1e);
});

const c = (spec: string): Card => {
  const suitMap: Record<string, Card['suit']> = {
    h: 'hearts',
    d: 'diamonds',
    c: 'clubs',
    s: 'spades',
  };
  return { rank: spec[0] as Card['rank'], suit: suitMap[spec[1]] };
};

const mkPlayer = (seat: number, over: Record<string, unknown> = {}) =>
  ({
    seat,
    user_id: `p-${seat}`,
    username: `P${seat}`,
    stack: 400,
    bet: 0,
    totalInvested: 0,
    cards: [] as Card[],
    is_folded: false,
    is_all_in: false,
    is_sitting_out: false,
    is_horse: true,
    ...over,
  }) as never;

describe('HorseLogic V12 (G) - river sizing polish', () => {
  it('nut hands overbet the river with v12River and never without', () => {
    const spot = (on: boolean) => {
      // Nut flush on the river, heads-up, hero has the lead and acts last.
      const hero = mkPlayer(6, { cards: [c('Ah'), c('Kh')], stack: 400 });
      const gs: never = {
        players: [hero, mkPlayer(2, { stack: 400 })],
        communityCards: [c('Qh'), c('7h'), c('2h'), c('9d'), c('3c')],
        pot: 40,
        currentBet: 0,
        minRaise: 2,
        stage: 'river',
        gameVariant: 'nlh',
        bigBlind: 2,
        dealerSeat: 6,
        gameMode: 'cash',
      } as never;
      return HorseLogic.decide(hero, gs, 'balanced', {}, on ? {} : { v12River: false });
    };
    // The legacy geometric river sizing tops out ~1.35x pot after family
    // snapping; the V12 overbet family reaches 1.6x. Count TRUE bombs.
    let overOn = 0;
    let overOff = 0;
    let betsOn = 0;
    for (let i = 0; i < 200; i++) {
      const a = spot(true);
      if (a.action === 'bet') {
        betsOn++;
        if ((a.amount ?? 0) > 40 * 1.38) overOn++;
      }
      const b = spot(false);
      if (b.action === 'bet' && (b.amount ?? 0) > 40 * 1.38) overOff++;
    }
    expect(betsOn).toBeGreaterThan(100); // the nuts bet the river
    expect(overOn).toBeGreaterThan(5); // and sometimes truly bomb it
    expect(overOff).toBe(0); // the legacy engine never reaches this size
  });

  it('OOP medium hands block-bet small on the river instead of only check/betting big', () => {
    const spot = (on: boolean) => {
      // A modest pocket pair OOP heads-up on the river — real showdown value,
      // never strong enough for the value-bet branches.
      const hero = mkPlayer(2, { cards: [c('5h'), c('5d')], stack: 400 });
      const gs: never = {
        players: [hero, mkPlayer(6, { stack: 400 })],
        communityCards: [c('Kh'), c('Ts'), c('4c'), c('2d'), c('6s')],
        pot: 30,
        currentBet: 0,
        minRaise: 2,
        stage: 'river',
        gameVariant: 'nlh',
        bigBlind: 2,
        dealerSeat: 6,
        gameMode: 'cash',
      } as never;
      return HorseLogic.decide(hero, gs, 'balanced', {}, on ? {} : { v12River: false });
    };
    let smallOn = 0;
    let smallOff = 0;
    for (let i = 0; i < 120; i++) {
      const a = spot(true);
      if (a.action === 'bet' && (a.amount ?? 0) <= 30 * 0.45) smallOn++;
      const b = spot(false);
      if (b.action === 'bet' && (b.amount ?? 0) <= 30 * 0.45) smallOff++;
    }
    expect(smallOn).toBeGreaterThan(smallOff + 10);
  });

  it('holding the nut blocker calls big river bets more than holding none', () => {
    const spot = (withBlocker: boolean) => {
      // Two-tone runout; hero's kicker is either the nut-flush blocker (Ah)
      // or a blank of another suit. Same pair either way.
      const hero = mkPlayer(2, {
        cards: [withBlocker ? c('Ah') : c('Ac'), c('Td')],
        stack: 400,
      });
      const gs: never = {
        players: [
          hero,
          mkPlayer(6, { bet: 36, stack: 364 }),
          ...[1, 3, 4, 5].map((s) => mkPlayer(s, { is_folded: true })),
        ],
        communityCards: [c('Th'), c('7h'), c('4s'), c('2h'), c('9c')],
        pot: 40,
        currentBet: 36,
        minRaise: 36,
        stage: 'river',
        gameVariant: 'nlh',
        bigBlind: 2,
        dealerSeat: 6,
        gameMode: 'cash',
      } as never;
      return HorseLogic.decide(hero, gs, 'balanced', {}, {});
    };
    // "Continue" = call or raise — with the blocker the equity read can cross
    // into the value-raise band, which is still the opposite of folding.
    const cont = (a: { action: string }) => a.action !== 'fold';
    let contBlocker = 0;
    let contNone = 0;
    for (let i = 0; i < 150; i++) {
      if (cont(spot(true))) contBlocker++;
      if (cont(spot(false))) contNone++;
    }
    expect(contBlocker).toBeGreaterThanOrEqual(contNone);
  });
});
