/**
 * MOVING DOWN A STAKE, AND BACK UP — the rule Dan asked for and nothing did.
 *
 * `canMoveUp`, `shouldMoveDown` and `bestAffordableGame` shipped this morning
 * correct, tested, and with ZERO callers. The reason they COULD not be called
 * is the subject of most of these pins: the band was an exact match, so a
 * horse that could no longer afford its own stake did not move down, it
 * stopped playing. Measured before any reset, 175 of 584 horses were banded
 * into a stake with no open table at all.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HorseStakeBand } from './HorseBehavior.js';
import { bankrollPolicyFor, bankrollTemperamentFor } from './HorseBankroll.js';
import {
  BAND_ORDER,
  descendedCount,
  resetStakeDescent,
  resolveStakeBand,
} from './HorseStakeDescent.js';
import { bankrollCounters, resetBankrollCounters } from './HorseBankrollTelemetry.js';

const horseOf = (t: 'nit' | 'standard' | 'gambler') => {
  for (let i = 0; i < 5000; i++) {
    const id = `sd-${i}`;
    if (bankrollTemperamentFor(id) === t) return id;
  }
  throw new Error('none');
};

/** The live ladder on 2026-08-31, once the micro games reopen. */
const FULL: ReadonlyMap<HorseStakeBand, number> = new Map<HorseStakeBand, number>([
  ['micro', 50], // 0.25/0.50
  ['low', 200], // 1/2
  ['mid', 400], // 2/4
  ['high', 1000], // 5/10, were any open
]);

/** The ladder as it ACTUALLY stood: every micro table closed, nothing above 2/5. */
const AS_SHIPPED: ReadonlyMap<HorseStakeBand, number> = new Map<HorseStakeBand, number>([
  ['low', 200],
  ['mid', 400],
]);

const std = horseOf('standard'); // sit 25, down 17, up 35, of the REFERENCE buy-in

beforeEach(() => {
  resetStakeDescent();
  resetBankrollCounters();
});

describe('a band is a CEILING, never a floor', () => {
  it('a rich horse stays in the band it EARNED and is not promoted by money', () => {
    // The merit rule is untouched: a fat roll does not buy a seat in a bigger
    // game. That is the half of stakeBandAllows worth keeping.
    const r = resolveStakeBand({
      horseId: std,
      homeBand: 'low',
      bankroll: 10_000_000,
      bandRef: FULL,
      policy: bankrollPolicyFor(std),
    });
    expect(r.band).toBe('low');
    expect(r.movedUp).toBe(false);
  });

  it('a horse that cannot carry its own band MOVES DOWN rather than stopping', () => {
    // mid ref 400: standard needs 25 x 400 = 10,000 to sit, and leaves under
    // 17 x 400 = 6,800. At 3,000 it belongs at 1/2 (needs 5,000)... which it
    // also cannot afford, so it lands in micro (needs 1,250).
    const r = resolveStakeBand({
      horseId: std,
      homeBand: 'mid',
      bankroll: 3_000,
      bandRef: FULL,
      policy: bankrollPolicyFor(std),
    });
    expect(r.band).toBe('micro');
    expect(r.movedDown).toBe(true);
    expect(r.stranded).toBe(false);
    expect(bankrollCounters().moved_down_a_stake).toBe(1);
  });

  it('falls THROUGH a band that has no open table', () => {
    /* This is the shipped ladder: `micro` and `high` had no table at all, and
       an unpriceable band must not read as an affordable one. A `high` horse
       with a big roll lands in `mid`, the best game that actually exists at
       or below what it earned. */
    const r = resolveStakeBand({
      horseId: std,
      homeBand: 'high',
      bankroll: 40_000,
      bandRef: AS_SHIPPED,
      policy: bankrollPolicyFor(std),
    });
    expect(r.band).toBe('mid');
    expect(r.stranded).toBe(false);
  });

  it('a MERIT DEMOTION beats the latch — the ceiling can only ever fall', () => {
    /* The band is re-ranked every 30 minutes. A horse that had descended from
       `high` to `mid` carries `mid` in the latch; if merit then demotes it to
       `low`, the latch must not keep it in a game it no longer belongs in.
       Without the clamp the latch WINS and the horse plays above its earned
       band — the one thing this module must never allow. */
    const rich = 1_000_000;
    // Descend high -> mid, because `high` has no open table.
    expect(
      resolveStakeBand({
        horseId: std,
        homeBand: 'high',
        bankroll: rich,
        bandRef: AS_SHIPPED,
        policy: bankrollPolicyFor(std),
      }).band
    ).toBe('mid');
    // Merit demotes it to `low`. The roll is unchanged and enormous.
    expect(
      resolveStakeBand({
        horseId: std,
        homeBand: 'low',
        bankroll: rich,
        bandRef: AS_SHIPPED,
        policy: bankrollPolicyFor(std),
      }).band
    ).toBe('low');
  });

  it('reports STRANDED when the bottom rung is still unaffordable', () => {
    // 800 chips against a 200 floor: 4 buy-ins, and standard needs 25.
    const r = resolveStakeBand({
      horseId: std,
      homeBand: 'low',
      bankroll: 800,
      bandRef: AS_SHIPPED,
      policy: bankrollPolicyFor(std),
    });
    expect(r.stranded).toBe(true);
  });
});

describe('hysteresis — three thresholds, so the ladder is not a metronome', () => {
  const roll = (b: number) =>
    resolveStakeBand({
      horseId: std,
      homeBand: 'mid',
      bankroll: b,
      bandRef: FULL,
      policy: bankrollPolicyFor(std),
    });

  it('drops at the LOWER bar, not the sit bar', () => {
    // mid ref 400. sit 10,000 / moveDown 6,800 / moveUp 14,000.
    expect(roll(10_000).band).toBe('mid'); // comfortably in
    resetStakeDescent();
    expect(roll(7_000).band).toBe('mid'); // BELOW the sit bar and still stays
    resetStakeDescent();
    expect(roll(6_000).band).toBe('low'); // under moveDown: now it goes
  });

  it('climbs back only at the HIGHER bar — the whole point of the gap', () => {
    expect(roll(6_000).band).toBe('low'); // descended
    // Back above the sit bar, but NOT the move-up bar: it stays put. Without
    // this the horse flaps between two stakes every seeding cycle, forever.
    expect(roll(11_000).band).toBe('low');
    expect(roll(14_000).band).toBe('mid'); // clears moveUp: home
    expect(bankrollCounters().moved_up_a_stake).toBe(1);
  });

  it('climbs one rung at a time and never past the earned band', () => {
    expect(roll(1_000).band).toBe('micro');
    expect(roll(1_000_000).band).toBe('mid'); // straight home, never above it
  });

  it('forgets a horse that is back where it belongs', () => {
    expect(roll(6_000).band).toBe('low');
    expect(descendedCount()).toBe(1);
    expect(roll(1_000_000).band).toBe('mid');
    expect(descendedCount()).toBe(0);
  });
});

describe('failing open, and the order of the ladder', () => {
  it('BAND_ORDER runs cheapest to dearest — descent walks left', () => {
    expect([...BAND_ORDER]).toEqual(['micro', 'low', 'mid', 'high']);
  });

  it('an unknown roll changes nothing at all', () => {
    const r = resolveStakeBand({
      horseId: std,
      homeBand: 'mid',
      bankroll: 0,
      bandRef: FULL,
      policy: bankrollPolicyFor(std),
    });
    expect(r.band).toBe('mid');
    expect(r.movedDown).toBe(false);
  });

  it('an empty ladder leaves the horse in its home band', () => {
    const r = resolveStakeBand({
      horseId: std,
      homeBand: 'low',
      bankroll: 50_000,
      bandRef: new Map(),
      policy: bankrollPolicyFor(std),
    });
    expect(r.band).toBe('low');
    // Nothing is priceable, so nothing is sittable — and it says so.
    expect(r.stranded).toBe(true);
  });

  it('temperament orders the descent: a nit drops before a gambler does', () => {
    const nit = horseOf('nit');
    const gam = horseOf('gambler');
    const at = (id: string) =>
      resolveStakeBand({
        horseId: id,
        homeBand: 'mid',
        bankroll: 8_000,
        bandRef: FULL,
        policy: bankrollPolicyFor(id),
      }).band;
    // mid ref 400 -> nit leaves under 28x400=11,200; gambler under 8x400=3,200.
    expect(at(nit)).not.toBe('mid');
    expect(at(gam)).toBe('mid');
  });
});

/**
 * The other half of moving down: the seating gate only ever runs BEFORE a
 * horse sits, so the ladder could demote a horse in principle while it went on
 * playing a game it could not afford in practice. These pins were added
 * because deleting the rotator's stand-up left every existing descent pin
 * green - the behaviour shipped unguarded in the reverted work.
 */
describe('WIRING - the rotator stands up a horse that can no longer afford the game', () => {
  const ROTATOR = readFileSync(join(process.cwd(), 'src/services/HorseSessionRotator.ts'), 'utf8');
  const FLEET = readFileSync(join(process.cwd(), 'src/services/HorseFleetManager.ts'), 'utf8');

  it('counts the reason AND actually leaves - the count alone changes nothing', () => {
    expect(ROTATOR).toMatch(
      /bankrollEvent\('left_underrolled'\);\s*best = \{ seat, p: Number\.POSITIVE_INFINITY \};\s*break;/
    );
  });

  /**
   * The LOOSER bar deliberately: `shouldMoveDown` (17 buy-ins) against
   * `canSit`'s 25. A horse that merely dips under the entry bar mid session
   * finishes what it is doing rather than jumping up from the table. Using
   * canSit here would stand horses up the moment they dipped, and the seating
   * gate would then refuse to re-seat them - a metronome with an empty floor
   * at one end.
   */
  it('leaves at the LOOSER bar, so leaving and re-sitting cannot chase each other', () => {
    expect(ROTATOR).toMatch(/shouldMoveDown\(\s*rollNow,/);
    expect(ROTATOR).not.toMatch(/canSit\(\s*rollNow,/);
  });

  it('an unreadable roll never stands a horse up', () => {
    expect(ROTATOR).toMatch(/rollNow !== undefined &&\s*shouldMoveDown\(/);
  });

  it('the ladder is priced from tables that exist, not from a constant', () => {
    expect(FLEET).toMatch(/const bandRef = new Map<HorseStakeBand, number>\(\);/);
    /* Surplus tables are being wound down and must not price a rung. Anchored
       to the bandRef loop specifically: the ladder-exhausted gauge above has
       the same `for (const t of tables)` / surplus-skip shape, so a looser
       pattern matched THAT one and stayed green with this skip deleted.
       Caught by mutation. */
    const bandRefAt = FLEET.indexOf('const bandRef = new Map<HorseStakeBand, number>();');
    const bandRefLoop = FLEET.slice(bandRefAt, FLEET.indexOf('bandRef.set(b, r);', bandRefAt));
    expect(bandRefLoop).toContain('if (surplusTableIds.has(t.id)) continue;');
    expect(bandRefLoop).toContain('stakeBandForBigBlind(Number(t.big_blind))');
  });
});
