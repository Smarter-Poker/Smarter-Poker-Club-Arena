/**
 * The browser-side re-check of a Plinko drop and a Crash round must agree with
 * Postgres byte for byte. Vectors produced by production Postgres 2026-09-08:
 *
 *   with h as (select decode('65caaaac...a868','hex') b)
 *   select sum(get_bit(b,i)), sum(get_bit(b,i) << i),
 *          string_agg(get_bit(b,i)::text, '' order by i)          -- 8, 51813, 1010011001010011
 *     from h, generate_series(0,15) i;
 *   select fn_crash_point_cents(111921121211850);                 -- 201
 *   select fn_crash_point_cents(1000);                            -- 22495502634218
 *   select fn_crash_point_cents(281474976710655);                 -- 100
 *   select fn_crash_multiplier_cents(0.12, 10000, 100000);        -- 332
 *
 * The HMAC is the wheel vector's (seed a3f1..., client 'lucky-seven', nonce 7).
 */
import { describe, expect, it } from 'vitest';
import {
  PLINKO_SLOT_WEIGHTS,
  PLINKO_WEIGHT_TOTAL,
  crashMultiplierCents,
  crashPointCentsFromRoll,
  crashSecondsToReach,
  multiplierLabel,
  plinkoBitsFromPathBits,
  plinkoPathFromHmacHex,
  verifyCrashRound,
  verifyPlinkoDrop,
} from '../../src/utils/diamondGamesFairness';

const SEED = 'a3f1c2d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const SEED_HASH = '6562095d0b88a7960aca86fc2b3be51f9f9193b15d206b1ccc5e1d230d21a391';
const HMAC = '65caaaac35ca5f00521cfe6e03185b87bb935b805cead6ab93f610821c4fa868';
const ROLL = 111921121211850;

describe('plinko: the path is the first sixteen bits of the HMAC, get_bit order', () => {
  it('reads bit i as bit (i mod 8) of byte (i div 8), least significant first', () => {
    const p = plinkoPathFromHmacHex(HMAC);
    expect(p.bits.join('')).toBe('1010011001010011');
    expect(p.slot).toBe(8);
    expect(p.pathBits).toBe(51813);
    expect(plinkoBitsFromPathBits(51813)).toEqual(p.bits);
  });

  it('the binomial weights sum to 65,536 and the edge is 1 in 32,768 either side', () => {
    expect(PLINKO_SLOT_WEIGHTS.reduce((a, b) => a + b, 0)).toBe(PLINKO_WEIGHT_TOTAL);
    expect(PLINKO_SLOT_WEIGHTS[0]).toBe(1);
    expect(PLINKO_SLOT_WEIGHTS[16]).toBe(1);
    expect(PLINKO_SLOT_WEIGHTS[8]).toBe(12870);
  });

  it('gives a full verdict and refuses a forged seed', async () => {
    const fair = await verifyPlinkoDrop({
      serverSeed: SEED,
      serverSeedHash: SEED_HASH,
      clientSeed: 'lucky-seven',
      nonce: 7,
      hmacHex: HMAC,
      slot: 8,
      pathBits: 51813,
    });
    expect(fair.fair).toBe(true);
    const forged = await verifyPlinkoDrop({
      serverSeed: SEED.replace('a3f1', 'a3f2'),
      serverSeedHash: SEED_HASH,
      clientSeed: 'lucky-seven',
      nonce: 7,
      hmacHex: HMAC,
      slot: 8,
      pathBits: 51813,
    });
    expect(forged.hashMatches).toBe(false);
    expect(forged.fair).toBe(false);
  });
});

describe('crash: floor(80 * 2^48 / (roll + 1)) cents, floored at 1.00', () => {
  it('matches Postgres on the pinned rolls', () => {
    expect(crashPointCentsFromRoll(ROLL)).toBe(201);
    expect(crashPointCentsFromRoll(1000)).toBe(22495502634218);
    expect(crashPointCentsFromRoll(281474976710655)).toBe(100);
    expect(crashPointCentsFromRoll(0)).toBe(22517998136852480);
  });

  it('returns 80 percent at every target: P(X >= x) is 0.8 / x to the 48-bit grain', () => {
    // The largest roll that still reaches x is floor(80 * 2^48 / x) - 1.
    for (const cents of [101, 150, 200, 500, 5000, 100000]) {
      const rolls = Math.floor((80 * 2 ** 48) / cents);
      const p = rolls / 2 ** 48;
      expect(p * (cents / 100)).toBeCloseTo(0.8, 9);
    }
  });

  it('the curve and its inverse agree with Postgres', () => {
    expect(crashMultiplierCents(0.12, 10000, 100000)).toBe(332);
    expect(crashMultiplierCents(0.12, 0, 100000)).toBe(100);
    expect(crashMultiplierCents(0.12, 600000, 100000)).toBe(100000);
    expect(crashSecondsToReach(0.12, 200)).toBeCloseTo(5.776, 3);
    expect(crashSecondsToReach(0.12, 100000)).toBeCloseTo(57.565, 3);
  });

  it('gives a full verdict for a settled round', async () => {
    const v = await verifyCrashRound({
      serverSeed: SEED,
      serverSeedHash: SEED_HASH,
      clientSeed: 'lucky-seven',
      nonce: 7,
      roll: ROLL,
      crashCents: 201,
    });
    expect(v.fair).toBe(true);
    expect(v.computedRoll).toBe(ROLL);
    const wrong = await verifyCrashRound({
      serverSeed: SEED,
      serverSeedHash: SEED_HASH,
      clientSeed: 'lucky-seven',
      nonce: 7,
      roll: ROLL,
      crashCents: 202,
    });
    expect(wrong.crashMatches).toBe(false);
    expect(wrong.fair).toBe(false);
  });
});

describe('multiplier labels', () => {
  it('prints cents as the player reads them', () => {
    expect(multiplierLabel(100)).toBe('1x');
    expect(multiplierLabel(995)).toBe('9.95x');
    expect(multiplierLabel(1050)).toBe('10.5x');
    expect(multiplierLabel(2025)).toBe('20.25x');
    expect(multiplierLabel(65)).toBe('0.65x');
    expect(multiplierLabel(100000)).toBe('1000x');
  });
});
