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
 * The one-argument fn_crash_point_cents is the no-minimum game those vectors
 * come from, which the three-argument one reproduces at bet 1 and minimum 0:
 *
 *   select fn_crash_point_cents(111921121211850, 1, 0);           -- 201
 *
 * The odds below are the 2026-09-22 fairness audit's: a round that funds a
 * guaranteed minimum L out of its own odds crashes at 1.00x
 * 1 - (0.8 - L) / (1.01 - L) of the time - 1 in 4.8 at L = 0 (the "1 In 5" the
 * lobby printed), 1 in 4.3 at a tenth of the stake, 1 in 2.4 at a half.
 */
import { describe, expect, it } from 'vitest';
import {
  PLINKO_SLOT_WEIGHTS,
  PLINKO_WEIGHT_TOTAL,
  awardInstantCrashChances,
  crashInstantChance,
  crashMissChance,
  crashMultiplierCents,
  crashPointCentsFromRoll,
  crashSecondsToReach,
  multiplierLabel,
  oneInLabel,
  oneInRangeLabel,
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

describe('crash: L + (0.8 - L) / u, in cents, floored at 1.00', () => {
  it('matches Postgres on the pinned rolls', () => {
    expect(crashPointCentsFromRoll(ROLL, 1, 0)).toBe(201);
    expect(crashPointCentsFromRoll(1000, 1, 0)).toBe(22495502634218);
    expect(crashPointCentsFromRoll(281474976710655, 1, 0)).toBe(100);
    expect(crashPointCentsFromRoll(0, 1, 0)).toBe(22517998136852480);
  });

  it('is checked with the bet and the minimum of the round, never without them', () => {
    // The audit's finding: the defaults recomputed the no-minimum game, so a
    // third party following them disagreed with four of six award rounds.
    const noArgs = crashPointCentsFromRoll as unknown as (roll: number) => number;
    expect(() => noArgs(ROLL)).toThrow('A Crash Round Is Checked With Its Bet And Its Minimum');
    expect(crashPointCentsFromRoll(ROLL, 1, 0.1)).not.toBe(crashPointCentsFromRoll(ROLL, 1, 0));
  });

  it('returns 80 percent at every target on a no-minimum round: P(X >= x) is 0.8 / x', () => {
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
      betChips: 1,
      minimumPayoutChips: 0,
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
      betChips: 1,
      minimumPayoutChips: 0,
    });
    expect(wrong.crashMatches).toBe(false);
    expect(wrong.fair).toBe(false);
    // The same round with a tenth of the stake guaranteed is a different point,
    // so a verifier handed the round without its minimum reports a mismatch.
    const blind = await verifyCrashRound({
      serverSeed: SEED,
      serverSeedHash: SEED_HASH,
      clientSeed: 'lucky-seven',
      nonce: 7,
      roll: ROLL,
      crashCents: crashPointCentsFromRoll(ROLL, 1, 0.1),
      betChips: 1,
      minimumPayoutChips: 0,
    });
    expect(blind.hashMatches).toBe(true);
    expect(blind.crashMatches).toBe(false);
  });
});

describe('crash odds: the guaranteed minimum is paid for out of them', () => {
  const SPACE = 281474976710656n;
  /** The number of rolls that still reach `target`, exactly as the sealed point divides them. */
  const survivors = (target: number, bet: number, minimum: number) =>
    (100n * (4n * BigInt(Math.round(bet * 100)) - 5n * BigInt(Math.round(minimum * 100))) * SPACE) /
    (5n *
      (BigInt(Math.round(bet * 100)) * BigInt(target) - 100n * BigInt(Math.round(minimum * 100))));

  it('reads the audit figures at no minimum, a tenth and a half of the stake', () => {
    expect(crashInstantChance(1, 0)).toBeCloseTo(1 - 0.8 / 1.01, 12);
    // 4.81: what "1 In 5" was rounding, and true only while a crash paid nothing.
    expect(1 / crashInstantChance(1, 0)).toBeCloseTo(4.81, 2);
    expect(Math.round(1 / crashInstantChance(1, 0))).toBe(5);
    expect(1 / crashInstantChance(1, 0.1)).toBeCloseTo(4.3333, 4);
    expect(1 / crashInstantChance(1, 0.5)).toBeCloseTo(2.4286, 4);
    expect(oneInLabel(crashInstantChance(1, 0))).toBe('1 In 4.8');
    expect(oneInLabel(crashInstantChance(1, 0.1))).toBe('1 In 4.3');
    expect(oneInLabel(crashInstantChance(1, 0.5))).toBe('1 In 2.4');
    // The same three stated as the audit did: the share of the stake decides it.
    expect(crashInstantChance(50, 5)).toBeCloseTo(crashInstantChance(1, 0.1), 12);
    expect(crashInstantChance(50, 25)).toBeCloseTo(crashInstantChance(1, 0.5), 12);
  });

  it('agrees with the sealed crash point it is derived from, to the 48-bit grain', () => {
    for (const [bet, minimum] of [
      [1, 0],
      [1, 0.1],
      [1, 0.5],
      [0.25, 0.03],
      [25, 2.5],
    ] as const) {
      for (const target of [101, 150, 1000, 10000]) {
        const reached = survivors(target, bet, minimum);
        expect(crashPointCentsFromRoll(reached - 1n, bet, minimum)).toBeGreaterThanOrEqual(target);
        expect(crashPointCentsFromRoll(reached, bet, minimum)).toBeLessThan(target);
        expect(Number(SPACE - reached) / Number(SPACE)).toBeCloseTo(
          crashMissChance(target, bet, minimum),
          9
        );
      }
    }
    // Below the first hundredth nothing is missed: every round reaches 1.00x.
    expect(crashMissChance(100, 1, 0.1)).toBe(0);
  });

  it('covers every stake a wheel award can be played at, and refuses an impossible one', () => {
    const ordinary = awardInstantCrashChances(1, 100);
    const superAward = awardInstantCrashChances(2, 100);
    // An ordinary award keeps a tenth of its stake, rounded up to the cent, so a
    // small odd entry (31 diamonds keeps 4) crashes at 1.00x a shade more often.
    expect(1 / ordinary.least).toBeCloseTo(4.3333, 4);
    expect(1 / ordinary.most).toBeCloseTo(4.1953, 3);
    expect(oneInRangeLabel(ordinary)).toBe('1 In 4.2 To 4.3');
    // A Super award's half is exact on every stake it can be dealt.
    expect(1 / superAward.least).toBeCloseTo(2.4286, 4);
    expect(oneInRangeLabel(superAward)).toBe('1 In 2.4');
    expect(oneInRangeLabel({ most: 0.5, least: 0.5 })).toBe('1 In 2');
    // A minimum of four fifths of the stake leaves no odds to pay it with.
    expect(() => crashInstantChance(1, 0.8)).toThrow('Invalid Crash Outcome');
    expect(() => crashInstantChance(0, 0)).toThrow('Invalid Crash Outcome');
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
