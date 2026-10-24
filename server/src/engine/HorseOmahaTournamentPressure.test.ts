/**
 * V53 OMAHA TOURNAMENT PRESSURE (2026-10-24)
 *
 * Pins, in order:
 *  1. The pot-limit arithmetic: what an action risks, chip-EV and ICM
 *     required equity, the M fade, and the field reconciliation that refuses
 *     to guess hero's identity.
 *  2. The pressure itself on canonical spots: the bubble, short and covering
 *     stacks, the money, and the variant compression (PLO6 moves further than
 *     PLO4 for the same premium).
 *  3. The consumer: a priced shift reaches HorsePreflop's bars, and an absent
 *     read leaves every bar exactly where it was.
 *  4. Default off is byte-identical to the brain before V53 existed: the
 *     digest of a 4-variant real-hand tournament corpus with the flag absent
 *     equals the digest captured on origin/main ebe9363e with the same
 *     driver. With the flag on, Omaha decisions change and NLH decisions do
 *     not.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import {
  OMAHA_EQUITY_SLOPE,
  MAX_STRENGTH_SHIFT,
  buildIcmField,
  chipRequiredEquity,
  icmRequiredEquity,
  omahaPressureSlope,
  omahaTournamentPressure,
  potLimitRisk,
  pressureUrgency,
  type OmahaPressureInput,
} from './HorseOmahaTournamentPressure.js';
import { decidePreflopV7 } from './HorsePreflop.js';
import { seedFastRandom } from './HorseEval.js';
import { readFileSync } from 'node:fs';
import {
  CORPUS_BASE_OPTS,
  CORPUS_HANDS,
  CORPUS_SEED,
  CORPUS_VARIANTS,
  corpusDigest,
  playCorpus,
} from './HorseOmahaTournamentPressureCorpus.test-support.js';

const BUBBLE = [40, 25, 18, 10, 7];

/** A heads-up-relevant spot: hero vs one live opponent, plus remote stacks. */
function spot(
  heroStack: number,
  oppStack: number,
  payoutPct: number[],
  remote: number[],
  extra: Partial<OmahaPressureInput> = {}
): OmahaPressureInput {
  const fieldStacks = [heroStack, oppStack, ...remote];
  return {
    holeCount: 4,
    isHiLo: false,
    isPotLimit: true,
    heroUserId: 'hero',
    heroStack,
    heroBet: 0,
    pot: 150,
    contestablePot: 150,
    currentBet: 100,
    toCall: 100,
    bigBlind: 100,
    potRaiseTo: 450,
    unopened: true,
    lastRaiserUserId: null,
    opponents: [
      {
        userId: 'villain',
        stack: oppStack,
        bet: 0,
        folded: false,
        allIn: false,
        sittingOut: false,
        actsAfterHero: true,
      },
    ],
    fieldStacks,
    fieldStackByUser: { hero: heroStack, villain: oppStack },
    payoutPct,
    playersLeft: fieldStacks.length,
    realM: 12,
    ...extra,
  };
}

describe('V53 pot-limit risk and price arithmetic', () => {
  it('a flat call risks the call plus half the next pot-limit bet; a stack inside one pot bet is committed', () => {
    // 100 to call from 2,500 behind into a 250 pot: 2,400 left, far more than
    // one pot bet, so the risk is 100 + 0.5 x 250.
    expect(potLimitRisk(100, 2500, 250, 2500)).toBe(225);
    // 100 to call from 300 behind into a 250 pot: 200 left is within one
    // pot-sized bet, so the call commits the whole effective stack.
    expect(potLimitRisk(100, 300, 250, 300)).toBe(300);
    // Never more than the effective stack the opponent can actually take.
    expect(potLimitRisk(100, 2500, 250, 180)).toBe(180);
  });

  it('chip-EV required equity is risk over the final pot; ICM is the outcome-equity ratio', () => {
    // Risk 1,000 all-in, opponent matches 1,000, 500 already in: 1000/2500.
    expect(chipRequiredEquity(1000, 500, 0)).toBeCloseTo(0.4, 12);
    // Calling 1,000 of a shove into a 1,500 pot (the shove included).
    expect(chipRequiredEquity(1000, 1500, 1000)).toBeCloseTo(0.4, 12);
    expect(icmRequiredEquity(30, 40, 10)).toBeCloseTo(2 / 3, 12);
    // Winning cannot gain: no price clears it.
    expect(icmRequiredEquity(30, 30, 30)).toBe(1);
  });

  it('the premium fades linearly from M 7 to M 1', () => {
    expect(pressureUrgency(12)).toBe(1);
    expect(pressureUrgency(7)).toBe(1);
    expect(pressureUrgency(4)).toBeCloseTo(0.5, 12);
    expect(pressureUrgency(1)).toBe(0);
    expect(pressureUrgency(0.2)).toBe(0);
  });

  it('only PLO4/5/6 high, pot limit, have a slope; the slope falls with hole count', () => {
    expect(omahaPressureSlope(4, false, true)).toBe(OMAHA_EQUITY_SLOPE[4]);
    expect(omahaPressureSlope(6, false, true)).toBe(OMAHA_EQUITY_SLOPE[6]);
    expect(OMAHA_EQUITY_SLOPE[4]).toBeGreaterThan(OMAHA_EQUITY_SLOPE[5]);
    expect(OMAHA_EQUITY_SLOPE[5]).toBeGreaterThan(OMAHA_EQUITY_SLOPE[6]);
    expect(omahaPressureSlope(4, true, true)).toBeNull(); // PLO8
    expect(omahaPressureSlope(4, false, false)).toBeNull(); // FLO8 / limit
    expect(omahaPressureSlope(2, false, true)).toBeNull();
  });

  it('the field swaps each local cached total for the live stack, and refuses an unknown hero', () => {
    const f = buildIcmField([5000, 3000, 2600, 900], { hero: 2600, v: 3000 }, 'hero', [
      { userId: 'hero', stack: 2400 },
      { userId: 'v', stack: 2900 },
    ]);
    expect(f).not.toBeNull();
    expect([...f!.vector].sort((a, b) => b - a)).toEqual([5000, 2900, 2400, 900]);
    expect(f!.vector[f!.index.get('hero')!]).toBe(2400);
    expect(
      buildIcmField([5000, 3000], { hero: 1234 }, 'hero', [{ userId: 'hero', stack: 1200 }])
    ).toBeNull();
  });
});

describe('V53 tournament pressure on canonical spots', () => {
  const remote = [3000, 2000, 2500, 1200];

  it('returns nothing outside its scope', () => {
    expect(omahaTournamentPressure(spot(2500, 2500, BUBBLE, remote, { isHiLo: true }))).toBeNull();
    expect(omahaTournamentPressure(spot(2500, 2500, BUBBLE, remote, { holeCount: 2 }))).toBeNull();
    expect(
      omahaTournamentPressure(spot(2500, 2500, BUBBLE, remote, { fieldStackByUser: {} }))
    ).toBeNull();
    expect(omahaTournamentPressure(spot(2500, 2500, [0, 0], remote))).toBeNull();
  });

  it('on the stone bubble a call-off costs far more than its chip price, and more than a flat call', () => {
    const r = omahaTournamentPressure(spot(2500, 2500, BUBBLE, remote))!;
    expect(r.icmMethod).toBe('exact_mh');
    expect(r.risk.commit).toBe(2500);
    expect(r.premium.commit).toBeGreaterThan(0.08);
    expect(r.premium.commit).toBeGreaterThan(r.premium.raise);
    expect(r.premium.raise).toBeGreaterThan(r.premium.call);
    expect(r.shifts.commitCall).toBeGreaterThan(r.shifts.call);
    expect(r.shifts.call).toBeGreaterThan(0);
  });

  it('a covered short stack tightens its opens; the stack that covers it opens wider', () => {
    const covered = omahaTournamentPressure(spot(1500, 4000, BUBBLE, remote))!;
    const covering = omahaTournamentPressure(spot(4000, 1500, BUBBLE, remote))!;
    expect(covered.heroCovers).toBe(false);
    expect(covering.heroCovers).toBe(true);
    expect(covered.shifts.open).toBeGreaterThan(0.05);
    expect(covering.shifts.open).toBeLessThan(covered.shifts.open - 0.05);
    // The covered stack's risk is capped at its own stack, the covering
    // stack's at what the opponent can take.
    expect(covered.risk.commit).toBe(1500);
    expect(covering.risk.commit).toBe(1600);
    // The covered stack is under more pressure than the one covering it.
    expect(covered.premium.commit).toBeGreaterThan(covering.premium.commit);
    expect(covering.premium.opponentCommit).toBeGreaterThan(covered.premium.opponentCommit);
  });

  it('in the money, past the bubble, opens widen because the field is the one under pressure', () => {
    const itm = omahaTournamentPressure(spot(2500, 2500, [45, 27, 16, 12], [3000, 2500]))!;
    const bubble = omahaTournamentPressure(spot(2500, 2500, BUBBLE, remote))!;
    expect(itm.shifts.open).toBeLessThan(0);
    expect(itm.premium.commit).toBeLessThan(bubble.premium.commit);
  });

  it('a stack with no orbits left carries almost no survival premium', () => {
    const deep = omahaTournamentPressure(spot(2500, 2500, BUBBLE, remote))!;
    const burnt = omahaTournamentPressure(spot(2500, 2500, BUBBLE, remote, { realM: 1.5 }))!;
    expect(burnt.urgency).toBeCloseTo(0.5 / 6, 12);
    expect(burnt.shifts.call).toBeLessThan(deep.shifts.call / 5);
    expect(burnt.shifts.commitCall).toBeLessThan(deep.shifts.commitCall / 5);
  });

  it('PLO6 moves a bar further than PLO4 for the same premium (equity compression)', () => {
    const plo4 = omahaTournamentPressure(spot(2500, 2500, BUBBLE, remote))!;
    const plo6 = omahaTournamentPressure(spot(2500, 2500, BUBBLE, remote, { holeCount: 6 }))!;
    expect(plo6.premium.call).toBeCloseTo(plo4.premium.call, 12);
    expect(plo6.shifts.call).toBeGreaterThan(plo4.shifts.call);
    expect(plo6.shifts.call / plo4.shifts.call).toBeCloseTo(
      OMAHA_EQUITY_SLOPE[4] / OMAHA_EQUITY_SLOPE[6],
      3
    );
  });

  it('facing a pot raise, the raiser is the opponent and the pot-limit commitment shows in the risk', () => {
    const r = omahaTournamentPressure(
      spot(2500, 2150, BUBBLE, remote, {
        unopened: false,
        lastRaiserUserId: 'villain',
        currentBet: 350,
        toCall: 350,
        pot: 500,
        contestablePot: 500,
        potRaiseTo: 1550,
        fieldStackByUser: { hero: 2500, villain: 2500 },
        opponents: [
          {
            userId: 'villain',
            stack: 2150,
            bet: 350,
            folded: false,
            allIn: false,
            sittingOut: false,
            actsAfterHero: false,
          },
        ],
      })
    )!;
    expect(r.opponentUserId).toBe('villain');
    // The pot re-raise to 1,550 leaves 950 behind against a pot far larger
    // than that, so the re-raise is the whole stack.
    expect(r.risk.raise).toBe(2500);
    expect(r.risk.call).toBeGreaterThan(350);
    expect(r.shifts.call).toBeGreaterThan(0.05);
  });

  it('every shift is bounded and deterministic (no random stream is consumed)', () => {
    seedFastRandom(7);
    const a = omahaTournamentPressure(spot(1500, 4000, BUBBLE, remote));
    const b = omahaTournamentPressure(spot(1500, 4000, BUBBLE, remote));
    expect(a).toEqual(b);
    for (const v of Object.values(a!.shifts)) {
      expect(Math.abs(v)).toBeLessThanOrEqual(MAX_STRENGTH_SHIFT);
    }
  });

  it('a large field is priced with the same Monte Carlo model Phase 7 uses, and noise is not priced', () => {
    const big = omahaTournamentPressure(
      spot(2500, 2500, [30, 20, 14, 11, 9, 7, 5, 4], Array(40).fill(2500))
    )!;
    expect(big.icmMethod).toBe('plackett_luce_mc');
    // Small risks are read off the resolved commitment premium, so a flat
    // call can never be priced above the commitment it is a share of.
    expect(big.premium.call).toBeLessThanOrEqual(big.premium.commit);
    expect(big.premium.raise).toBeLessThanOrEqual(big.premium.commit);
  });
});

describe('V53 reaches the preflop bars, and only when present', () => {
  /** The V25 test fixture: a PLO tournament spot at 12bb, late position. */
  const ctx = (extra: Record<string, unknown> = {}) => ({
    strength: 0.62,
    position: 'late' as const,
    raiserPosition: null,
    raises: 0,
    limpers: 0,
    callers: 0,
    oppsLeft: 6,
    toCall: 100,
    currentBet: 100,
    pot: 250,
    bigBlind: 100,
    stack: 1200,
    stackBB: 12,
    tightness: 1,
    bluffFreq: 0.1,
    aggression: 1,
    slowplayFreq: 0.1,
    sizingMultiplier: 1,
    isOmaha: true,
    isPotLimit: true,
    riskAdd: 0.04,
    mode: 'tournament' as const,
    anteInPlay: true,
    anteOrbitBB: 1.0,
    tableSize: 8,
    ploPriceDefense: true,
    ploTourney: true,
    v13: true,
    rand: () => 0.5,
    ...extra,
  });
  const zero = {
    open: 0,
    threeBet: 0,
    fourBet: 0,
    call: 0,
    commitOpen: 0,
    commitCall: 0,
    bluffRisk: 0,
  };

  // The V25 commitment-zone bar here: late 0.56, minus the ante widen 0.05,
  // minus the red-zone widen 0.05 (effective M 3.84) = 0.46 before any
  // premium; riskAdd 0.04 lifts it to 0.50.
  it('a commitment the flat premium allows is folded when its ICM price is high', () => {
    expect(decidePreflopV7(ctx() as never).a).toBe('raiseTo');
    expect(decidePreflopV7(ctx({ ploIcm: { ...zero, commitOpen: 0.2 } }) as never).a).toBe('fold');
  });

  it('a covering stack commits hands the flat premium folds', () => {
    expect(decidePreflopV7(ctx({ strength: 0.44 }) as never).a).toBe('fold');
    expect(
      decidePreflopV7(ctx({ strength: 0.44, ploIcm: { ...zero, commitOpen: -0.04 } }) as never).a
    ).toBe('raiseTo');
  });

  it('the read REPLACES the flat premium: a zero read plays as riskAdd 0, not riskAdd + 0', () => {
    expect(decidePreflopV7(ctx({ strength: 0.48 }) as never).a).toBe('fold');
    expect(decidePreflopV7(ctx({ strength: 0.48, ploIcm: zero }) as never).a).toBe('raiseTo');
  });
});

describe(
  'V53 default off is byte-identical to the brain before it existed',
  { timeout: 600_000 },
  () => {
    /**
     * Captured 2026-10-24 on origin/main ebe9363e (before this layer) by
     * playCorpus(variant, CORPUS_HANDS, CORPUS_SEED, CORPUS_BASE_OPTS), and
     * reproduced twice there. Any change to these digests with the flag absent
     * is a change to today's live brain and needs its own measurement.
     */
    const PRE_V53_DIGESTS: Record<(typeof CORPUS_VARIANTS)[number], string> = {
      plo4: 'ecad85c185eed76c3111611c36d98705a022801334cf313515dd3e6d0aa78f12',
      plo5: '1dd7537bcb85d57b97e05e51314b4e0da1d5f4e2c779820639f4bff545f885e8',
      plo6: 'c1e890133d0d50c3929119bed2a9a997f0180e89d2e79faad13ce270a7f9c8d6',
      nlh: '613a6fc5ef395f94bc350fe920429848ccc6ad6251d414517f1361208fbdbf7b',
    };

    it.each(CORPUS_VARIANTS)('%s: flag absent replays the pre-V53 decisions exactly', (variant) => {
      const off = playCorpus(variant, CORPUS_HANDS, CORPUS_SEED, CORPUS_BASE_OPTS);
      expect(off.length).toBeGreaterThan(100);
      expect(corpusDigest(off)).toBe(PRE_V53_DIGESTS[variant]);
    });

    it('flag on changes PLO4 tournament decisions and leaves NLH untouched', () => {
      const on = { ...CORPUS_BASE_OPTS, v53PloTourneyIcm: true };
      const plo4 = playCorpus('plo4', CORPUS_HANDS, CORPUS_SEED, on);
      expect(corpusDigest(plo4)).not.toBe(PRE_V53_DIGESTS.plo4);
      const nlh = playCorpus('nlh', CORPUS_HANDS, CORPUS_SEED, on);
      expect(corpusDigest(nlh)).toBe(PRE_V53_DIGESTS.nlh);
    });

    it('is off unless asked for: the brain reads the flag as `=== true`', () => {
      const src = readFileSync('src/engine/HorseLogic.ts', 'utf8');
      expect(src).toContain('opts.v53PloTourneyIcm !== true');
      expect(src).not.toMatch(/v53PloTourneyIcm \?\? true/);
    });
  }
);
