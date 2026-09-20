/**
 * The browser-side re-check of a Diamond Wheel spin must agree with Postgres
 * byte for byte, or a fair spin would be reported as rigged (or a rigged one as
 * fair). The vector below was produced by production Postgres on 2026-09-08:
 *
 *   select encode(extensions.digest(seed,'sha256'),'hex'),
 *          encode(extensions.hmac(convert_to(cseed||':'||nonce::text,'UTF8'),
 *                                 convert_to(seed,'UTF8'),'sha256'),'hex'),
 *          (('x'||encode(substring(<hmac> from 1 for 6),'hex'))::bit(48)::bigint),
 *          floor(roll * 100000 / 281474976710656)
 *
 * with seed a3f1c2d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90,
 * client seed 'lucky-seven', nonce 7.
 */
import { describe, expect, it } from 'vitest';
import type { WheelDrawDomain } from '../../src/services/DiamondWheelService';
import {
  hmacSha256Hex,
  pickOrd,
  pointFromRoll,
  rollFromHmacHex,
  sha256Hex,
  verifyWheelSpin,
} from '../../src/utils/wheelFairness';

const SEED = 'a3f1c2d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const SEED_HASH = '6562095d0b88a7960aca86fc2b3be51f9f9193b15d206b1ccc5e1d230d21a391';
const HMAC = '65caaaac35ca5f00521cfe6e03185b87bb935b805cead6ab93f610821c4fa868';
const ROLL = 111921121211850;
const POINT = 39762;

/** Version 1 of the prize table, every tier eligible. */
const V1 = [
  { ord: 1, weight: 23470 },
  { ord: 2, weight: 24000 },
  { ord: 3, weight: 18000 },
  { ord: 4, weight: 16000 },
  { ord: 5, weight: 6000 },
  { ord: 6, weight: 5000 },
  { ord: 7, weight: 3000 },
  { ord: 8, weight: 3000 },
  { ord: 9, weight: 600 },
  { ord: 10, weight: 780 },
  { ord: 11, weight: 150 },
];

describe('the browser recomputes a spin exactly as Postgres does', () => {
  it('hashes the server seed the way the commit did', async () => {
    expect(await sha256Hex(SEED)).toBe(SEED_HASH);
  });

  it('computes the same HMAC and the same 48-bit roll', async () => {
    expect(await hmacSha256Hex(SEED, 'lucky-seven:7')).toBe(HMAC);
    expect(rollFromHmacHex(HMAC)).toBe(ROLL);
  });

  it('maps the roll onto the weights in exact integer arithmetic', () => {
    expect(pointFromRoll(ROLL, 100000)).toBe(POINT);
    // 39762 falls in the second tier: 23470 <= 39762 < 47470.
    expect(pickOrd(POINT, V1)).toBe(2);
  });

  it('walks only the eligible tiers, so a locked tier can never be picked', () => {
    const eligible = V1.filter((s) => s.ord !== 2);
    expect(pickOrd(POINT, eligible)).toBe(3);
    expect(pickOrd(99999, V1)).toBe(11);
    expect(pickOrd(0, V1)).toBe(1);
  });

  it('gives a full verdict, and refuses a seed that does not hash to the commitment', async () => {
    const fair = await verifyWheelSpin({
      serverSeed: SEED,
      serverSeedHash: SEED_HASH,
      clientSeed: 'lucky-seven',
      nonce: 7,
      roll: ROLL,
      weightTotal: 100000,
      eligible: V1,
      outcomeOrd: 2,
    });
    expect(fair.fair).toBe(true);
    expect(fair.computedPoint).toBe(POINT);

    const forged = await verifyWheelSpin({
      serverSeed: SEED.replace('a3f1', 'a3f2'),
      serverSeedHash: SEED_HASH,
      clientSeed: 'lucky-seven',
      nonce: 7,
      roll: ROLL,
      weightTotal: 100000,
      eligible: V1,
      outcomeOrd: 2,
    });
    expect(forged.hashMatches).toBe(false);
    expect(forged.fair).toBe(false);
  });
});

// Independent Python hashlib vectors for both versioned server draw domains.
it.each([
  ['wheel-v2', 248433345962604, 88261],
  ['wheel-v2-upgrade', 116590784161425, 41421],
  ['wheel-v3', 89420543953390, 31768],
  ['wheel-v3-upgrade', 88559417368527, 31462],
])(
  'verifies the distinct %s draw without changing legacy fairness',
  async (domain, roll, point) => {
    const eligible = [1, 2, 3, 4].map((ord) => ({ ord, weight: 25000 }));
    const v = await verifyWheelSpin({
      domain: domain as WheelDrawDomain,
      serverSeed: SEED,
      serverSeedHash: SEED_HASH,
      clientSeed: 'lucky-seven',
      nonce: 7,
      roll,
      weightTotal: 100000,
      eligible,
      outcomeOrd: Math.floor(point / 25000) + 1,
    });
    expect(v.fair).toBe(true);
    expect(v.computedPoint).toBe(point);
    expect(
      (
        await verifyWheelSpin({
          domain: domain === 'wheel-v2' ? 'wheel-v2-upgrade' : 'wheel-v2',
          serverSeed: SEED,
          serverSeedHash: SEED_HASH,
          clientSeed: 'lucky-seven',
          nonce: 7,
          roll,
          weightTotal: 100000,
          eligible,
          outcomeOrd: Math.floor(point / 25000) + 1,
        })
      ).fair
    ).toBe(false);
  }
);
