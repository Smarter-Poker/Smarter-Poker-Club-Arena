/**
 * Two starvation bugs shipped 2026-08-30, both still pinned here.
 *
 * 1. THE BUCKET WALK. The cash-table roll folded its time bucket into the weak
 *    `h*31+c` hash, so `h % 100` advanced by roughly +1 per bucket instead of
 *    re-rolling: a table that entered the band stayed in it for ~15
 *    consecutive buckets, and the short_deck room went dark for a day. The fix
 *    is the mix32 avalanche, and the pins below prove consecutive buckets are
 *    still decorrelated.
 *
 *    2026-09-02: the roll those pins guard is no longer "is this table held
 *    EMPTY" - Dan replaced the 15% held-empty rule with a 75/25 full/sporadic
 *    character (see HorseOccupancy.test.ts). The hash trap is identical and so
 *    is the cost of falling into it, so the pins moved to `cashTableFill`
 *    rather than being deleted with the rule.
 *
 * 2. pickFreeHorses read an unordered LIMITed page of profiles, which Postgres
 *    serves as the SAME physical rows all day. Once that page was busy,
 *    candidates filtered to zero while two-thirds of the fleet idled beyond the
 *    page and seat-first fills starved. The selection logic is now pure and fed
 *    the WHOLE fleet; these tests prove busy horses are excluded and selection
 *    can reach every horse.
 *
 * The "a variant must never go fully dark" pins are GONE with the rule they
 * protected: they existed because a held-empty roll on a variant's only table
 * switched that variant off entirely. Nothing is held empty any more - the
 * sparse quarter's floor is one seat - so there is no darkness to except.
 */

import { describe, it, expect } from 'vitest';
import {
  cashTableFill,
  occupancyTargetFor,
  FILL_BUCKET_MS,
  CASH_FULL_FRACTION,
  gameLaneFor,
  isActiveNow,
} from './HorseBehavior.js';
import { selectHorseCandidates } from './TournamentRecurringService.js';

const T0 = 1_700_000_000_000;
const tables = Array.from({ length: 400 }, (_, i) => `tbl-${i}-${i * 7919}`);

describe('the table character re-rolls each bucket, it does not walk', () => {
  it('no table stays sparse for a starvation-length run of consecutive buckets', () => {
    /* With an independent 25% roll per bucket, a run of 12 has probability
       ~6e-8 per start; across 400 tables x 48 buckets that is ~0.001 expected
       runs. The old walking hash produced runs of ~15 by construction, which
       is what took a variant's room dark for thirty hours. Deterministic
       inputs, so this is a pin, not a dice roll. */
    let worstRun = 0;
    for (const id of tables) {
      let run = 0;
      for (let b = 0; b < 48; b++) {
        if (cashTableFill(id, T0 + b * FILL_BUCKET_MS) === 'sporadic') {
          run++;
          worstRun = Math.max(worstRun, run);
        } else {
          run = 0;
        }
      }
    }
    expect(worstRun).toBeLessThan(12);
  });

  it('consecutive buckets are not correlated: transition rates match independence', () => {
    /* Under independence, P(sparse at b+1 | sparse at b) is just the base rate
       (~25%). Under the old +1-walk it was near 100% until the band was
       exhausted. Generous sampling slack either side. */
    let sparseNow = 0;
    let sparseBoth = 0;
    for (const id of tables) {
      for (let b = 0; b < 40; b++) {
        if (cashTableFill(id, T0 + b * FILL_BUCKET_MS) !== 'sporadic') continue;
        sparseNow++;
        if (cashTableFill(id, T0 + (b + 1) * FILL_BUCKET_MS) === 'sporadic') sparseBoth++;
      }
    }
    expect(sparseNow).toBeGreaterThan(100); // the sparse quarter still happens
    const conditional = sparseBoth / sparseNow;
    expect(conditional).toBeGreaterThan(0.12);
    expect(conditional).toBeLessThan(0.4);
  });

  it('every bucket splits the floor roughly 75/25', () => {
    for (let b = 0; b < 12; b++) {
      const now = T0 + b * FILL_BUCKET_MS;
      const full = tables.filter((id) => cashTableFill(id, now) === 'full').length / tables.length;
      expect(full, `bucket ${b}`).toBeGreaterThan(CASH_FULL_FRACTION - 0.09);
      expect(full, `bucket ${b}`).toBeLessThan(CASH_FULL_FRACTION + 0.09);
    }
  });

  it('and no bucket leaves a single table with nobody at it', () => {
    /* The rule this replaced put 15% of the floor at ZERO seats. Dan's floor
       is ONE, on every table, in every bucket. */
    for (let b = 0; b < 12; b++) {
      const now = T0 + b * FILL_BUCKET_MS;
      for (const id of tables) {
        expect(occupancyTargetFor(id, 6, false, now).seatTarget).toBeGreaterThanOrEqual(1);
      }
    }
  });
});

describe('pickFreeHorses selection covers the fleet and never picks a busy horse', () => {
  const fleet = Array.from({ length: 600 }, (_, i) => `horse-${i}-${i * 104729}`);

  it('a busy horse is never selected, wherever it sits in the fleet', () => {
    const busy = new Set(fleet.filter((_, i) => i % 3 === 0));
    const picked = selectHorseCandidates(fleet, busy, false, 12);
    expect(picked.length).toBeGreaterThan(0);
    for (const id of picked) expect(busy.has(id)).toBe(false);
  });

  it('selection reaches the whole fleet, not a stable first page', () => {
    // The old code could only ever return horses from the first N rows. Fed
    // the full fleet, eligible horses from the BACK of the list must appear.
    const picked = new Set(selectHorseCandidates(fleet, new Set(), false, 12));
    const backHalfEligible = fleet.slice(300).filter((id) => gameLaneFor(id) !== 'cash');
    expect(backHalfEligible.length).toBeGreaterThan(0);
    for (const id of backHalfEligible) expect(picked.has(id)).toBe(true);
  });

  it('draining part of the fleet still leaves the rest claimable', () => {
    // The starvation shape: mark every eligible horse in the front half busy
    // and the back half must still supply candidates.
    const eligible = fleet.filter((id) => gameLaneFor(id) !== 'cash');
    const busy = new Set(eligible.slice(0, Math.floor(eligible.length / 2)));
    const picked = selectHorseCandidates(fleet, busy, false, 12);
    expect(picked.length).toBeGreaterThan(0);
    expect(picked.length).toBe(eligible.length - busy.size);
  });

  it('allLanes (freeroll) admits cash-lane horses but honours the activity window', () => {
    const hour = 12;
    const picked = new Set(selectHorseCandidates(fleet, new Set(), true, hour));
    let cashLanePicked = 0;
    for (const id of picked) {
      expect(isActiveNow(id, hour)).toBe(true);
      if (gameLaneFor(id) === 'cash') cashLanePicked++;
    }
    expect(cashLanePicked).toBeGreaterThan(0);
  });
});
