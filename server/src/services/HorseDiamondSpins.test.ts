import { describe, it, expect } from 'vitest';
import {
  SPIN_ENTRIES,
  DIAMOND_RESERVE,
  cardChoice,
  cheapestGame,
  chooseEntry,
  choiceMovesWanted,
  crashCashoutCents,
  entryCapFor,
  cannotBeSeated,
  maxSpinTargetChips,
  mineCell,
  nextStep,
  plinkoDropValue,
  spinTargetChips,
  backoffForRefusal,
  type HorseSpinState,
} from './HorseDiamondSpins.js';
import { bankrollPolicyFor } from './HorseBankroll.js';

const GAME = { bigBlind: 0.1, minBuyIn: 4, maxBuyIn: 20 };

function horseOf(t: 'nit' | 'standard' | 'gambler'): string {
  for (let i = 0; i < 10_000; i++) {
    const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
    if (bankrollPolicyFor(id).temperament === t) return id;
  }
  throw new Error(`no ${t}`);
}
const NIT = horseOf('nit');
const STD = horseOf('standard');
const GAMBLER = horseOf('gambler');

function state(over: Partial<HorseSpinState> = {}): HorseSpinState {
  return {
    horseId: STD,
    clubId: 'club-a',
    chips: 0,
    diamonds: 100_000,
    targetChips: spinTargetChips(STD, GAME),
    inSession: true,
    cards: [],
    awards: [],
    crashRounds: [],
    choiceRounds: [],
    ...over,
  };
}

describe('the cheapest open game', () => {
  it('is the lowest big blind, then the lowest minimum', () => {
    expect(
      cheapestGame([
        { big_blind: '0.25', min_buy_in: '10', max_buy_in: '50' },
        { big_blind: '0.10', min_buy_in: '4', max_buy_in: '20' },
        { big_blind: '0.10', min_buy_in: '6', max_buy_in: '20' },
      ])
    ).toEqual({ bigBlind: 0.1, minBuyIn: 4, maxBuyIn: 20 });
  });
  it('is nothing when the host has no game open', () => {
    expect(cheapestGame([])).toBeNull();
    expect(cheapestGame([{ big_blind: 0, min_buy_in: 4, max_buy_in: 20 }])).toBeNull();
  });
});

describe('a horse spins when the fleet can no longer seat it', () => {
  it('starts under the seat bar, not only under one buy-in', () => {
    // A gambler needs 200 at a 0.10 game: at 150 it is refused every seat
    // while holding 37 buy-ins of the 4.00 minimum. Phase 4 left it there.
    expect(cannotBeSeated(GAMBLER, 0, GAME)).toBe(true);
    expect(cannotBeSeated(GAMBLER, 3.99, GAME)).toBe(true);
    expect(cannotBeSeated(GAMBLER, 150, GAME)).toBe(true);
    expect(cannotBeSeated(GAMBLER, 199.99, GAME)).toBe(true);
    expect(cannotBeSeated(GAMBLER, 200, GAME)).toBe(false);
  });
  it('uses each temperament’s own bar', () => {
    expect(cannotBeSeated(NIT, 399, GAME)).toBe(true);
    expect(cannotBeSeated(NIT, 400, GAME)).toBe(false);
    expect(cannotBeSeated(STD, 249, GAME)).toBe(true);
    expect(cannotBeSeated(STD, 250, GAME)).toBe(false);
  });
});

describe('a horse spins up to the bar the fleet seats it at', () => {
  it('meets the seat gate and bankroll rule 1 for every temperament', () => {
    // 0.10 big blind: 100bb = 10 chips. Gate = max(20, buyInsToSit) buy-ins.
    expect(spinTargetChips(NIT, GAME)).toBe(400);
    expect(spinTargetChips(STD, GAME)).toBe(250);
    expect(spinTargetChips(GAMBLER, GAME)).toBe(200);
    expect(maxSpinTargetChips(GAME)).toBe(400);
  });
});

describe('the entry for each spin', () => {
  it('never spends the Diamond Arena reserve', () => {
    expect(
      chooseEntry({ horseId: GAMBLER, chips: 0, targetChips: 200, diamonds: DIAMOND_RESERVE + 24 })
    ).toBeNull();
    expect(
      chooseEntry({ horseId: GAMBLER, chips: 0, targetChips: 200, diamonds: DIAMOND_RESERVE + 600 })
    ).toBe(500);
  });
  it('is capped by temperament', () => {
    expect(entryCapFor(NIT)).toBe(500);
    expect(entryCapFor(STD)).toBe(1000);
    expect(entryCapFor(GAMBLER)).toBe(2500);
    expect(chooseEntry({ horseId: GAMBLER, chips: 0, targetChips: 200, diamonds: 100_000 })).toBe(
      2500
    );
    expect(chooseEntry({ horseId: NIT, chips: 0, targetChips: 400, diamonds: 100_000 })).toBe(500);
  });
  it('is no bigger than the gap needs, and stops at the target', () => {
    // 1 chip short at 0.8 return needs 125 Diamonds: the 100 entry.
    expect(chooseEntry({ horseId: GAMBLER, chips: 199, targetChips: 200, diamonds: 100_000 })).toBe(
      100
    );
    expect(
      chooseEntry({ horseId: GAMBLER, chips: 199.9, targetChips: 200, diamonds: 100_000 })
    ).toBe(25);
    expect(
      chooseEntry({ horseId: GAMBLER, chips: 200, targetChips: 200, diamonds: 100_000 })
    ).toBeNull();
  });
  it('is always an entry the wheel offers', () => {
    for (const chips of [0, 10, 150, 199]) {
      const e = chooseEntry({ horseId: STD, chips, targetChips: 250, diamonds: 50_000 });
      expect(SPIN_ENTRIES as readonly number[]).toContain(e);
    }
  });
});

describe('how a horse plays its bonus games', () => {
  it('plays every Plinko Diamond in one to twenty drops of a listed value', () => {
    for (const total of [25, 100, 200, 500, 1000, 2000, 2500, 5000]) {
      const d = plinkoDropValue(total);
      expect(total % d).toBe(0);
      expect(total / d).toBeGreaterThanOrEqual(1);
      expect(total / d).toBeLessThanOrEqual(20);
    }
  });
  it('cashes a Crash out at or above the 1.26x floor', () => {
    for (const h of [NIT, STD, GAMBLER]) {
      for (let i = 0; i < 50; i++) {
        const c = crashCashoutCents(h, `award-${i}`);
        expect(c).toBeGreaterThanOrEqual(126);
        expect(c).toBeLessThanOrEqual(400);
      }
    }
  });
  it('turns a card from one to three, the same one every time', () => {
    for (let i = 0; i < 30; i++) {
      const c = cardChoice(STD, `a${i}`);
      expect([1, 2, 3]).toContain(c);
      expect(cardChoice(STD, `a${i}`)).toBe(c);
    }
  });
  it('opens distinct Mines tiles on the board', () => {
    const picked: number[] = [];
    for (let i = 0; i < 25; i++) {
      const c = mineCell(STD, 'round-1', picked);
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThanOrEqual(24);
      expect(picked).not.toContain(c);
      picked.push(c);
    }
  });
  it('takes one to four moves and never more than the round allows', () => {
    for (const h of [NIT, STD, GAMBLER]) {
      for (let i = 0; i < 20; i++) {
        const n = choiceMovesWanted(h, `r${i}`, 10);
        expect(n).toBeGreaterThanOrEqual(1);
        expect(n).toBeLessThanOrEqual(4);
      }
      expect(choiceMovesWanted(h, 'r', 1)).toBe(1);
    }
  });
});

describe('the order a horse does things in is the order the wheel requires', () => {
  it('turns a waiting card before anything else', () => {
    const s = state({
      cards: [{ id: 'card-1', clubId: 'club-a' }],
      awards: [
        { id: 'aw', clubId: 'club-a', game: 'plinko', baseDiamonds: 100, createdAt: '2026' },
      ],
    });
    expect(nextStep(s)).toMatchObject({ kind: 'pick_card', awardId: 'card-1' });
  });
  it('finishes a round in play before starting the next prize', () => {
    const s = state({
      crashRounds: [{ id: 'cr', clubId: 'club-a' }],
      awards: [
        { id: 'aw', clubId: 'club-a', game: 'plinko', baseDiamonds: 100, createdAt: '2026' },
      ],
    });
    expect(nextStep(s)).toEqual({ kind: 'crash_settle', roundId: 'cr' });
  });
  it('crosses the street it is on, then cashes out', () => {
    const r = { id: 'ch', clubId: 'club-a', game: 'crossing' as const, picked: [], maxSteps: 10 };
    expect(nextStep(state({ choiceRounds: [r] }))).toEqual({
      kind: 'choice_move',
      roundId: 'ch',
      action: 'pick',
      cell: 0,
      expectedStep: 0,
    });
    const wanted = choiceMovesWanted(STD, 'ch', 10);
    const done = { ...r, picked: [...Array(wanted).keys()] };
    expect(nextStep(state({ choiceRounds: [done] }))).toMatchObject({
      action: 'cashout',
      expectedStep: wanted,
    });
  });
  it('plays the earliest prize first', () => {
    const s = state({
      awards: [
        {
          id: 'late',
          clubId: 'club-a',
          game: 'mines',
          baseDiamonds: 100,
          createdAt: '2026-10-19T10:00:01Z',
        },
        {
          id: 'early',
          clubId: 'club-a',
          game: 'crash',
          baseDiamonds: 100,
          createdAt: '2026-10-19T10:00:00Z',
        },
      ],
    });
    expect(nextStep(s)).toMatchObject({ kind: 'start_bonus', award: { id: 'early' } });
  });
  it('plays a won prize even once it is no longer out of chips', () => {
    const s = state({
      chips: 10_000,
      inSession: false,
      awards: [
        { id: 'aw', clubId: 'club-a', game: 'plinko', baseDiamonds: 100, createdAt: '2026' },
      ],
    });
    expect(nextStep(s)).toMatchObject({ kind: 'start_bonus' });
  });
  it('spins only while in session and under target', () => {
    expect(nextStep(state())).toMatchObject({ kind: 'spin' });
    expect(nextStep(state({ inSession: false }))).toEqual({ kind: 'rest' });
    expect(nextStep(state({ chips: 250 }))).toEqual({ kind: 'rest' });
  });
  it('leaves another club’s work to that club', () => {
    const s = state({ inSession: false, cards: [{ id: 'c', clubId: 'club-b' }] });
    expect(nextStep(s)).toEqual({ kind: 'rest' });
  });
});

describe('refusals', () => {
  it('backs off the wheel’s own limits, and reports the unknown', () => {
    expect(backoffForRefusal('One Moment Between Spins')).toBe(5_000);
    expect(backoffForRefusal('The Host Must Fund Every Prize Before A Spin')).toBe(30 * 60_000);
    expect(backoffForRefusal('The Platform Is In Its Maintenance Break')).toBe(6 * 60_000);
    expect(backoffForRefusal('Something Nobody Planned')).toBeNull();
  });
});
