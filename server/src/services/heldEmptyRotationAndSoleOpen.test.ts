/**
 * Two starvation bugs shipped 2026-08-30, both pinned here so they cannot
 * come back:
 *
 * 1. cashTableHeldEmpty folded the 2h bucket into the weak `h*31+c` hash, so
 *    `h % 100` advanced by roughly +1 per bucket instead of re-rolling. A
 *    table that entered the <15 held-empty band stayed held for ~15
 *    consecutive buckets (~30 hours) — the short_deck room went dark for a
 *    day. The fix is the same mix32 avalanche seatFirstHeldEmpty already
 *    uses; these tests prove consecutive buckets are decorrelated.
 *
 * 2. pickFreeHorses read an unordered LIMITed page of profiles, which
 *    Postgres serves as the SAME physical rows all day. Once that page was
 *    busy, candidates filtered to zero while two-thirds of the fleet idled
 *    beyond the page and seat-first fills starved (SNG board dead from
 *    17:31 UTC). The selection logic is now pure and fed the WHOLE fleet;
 *    these tests prove busy horses are excluded and selection can reach
 *    every horse in the fleet.
 *
 * Plus the new law: a variant must never go fully dark — the only open table
 * for its variant config is never held empty.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  cashTableHeldEmpty,
  occupancyTargetFor,
  setSoleOpenCashTables,
  EMPTY_BUCKET_MS,
  CASH_EMPTY_FRACTION,
  gameLaneFor,
  isActiveNow,
} from './HorseBehavior.js';
import { selectHorseCandidates } from './TournamentRecurringService.js';

const T0 = 1_700_000_000_000;
const tables = Array.from({ length: 400 }, (_, i) => `tbl-${i}-${i * 7919}`);

afterEach(() => setSoleOpenCashTables([]));

describe('held-empty rotation is a re-roll, not a walk', () => {
  it('no table stays held for a starvation-length run of consecutive buckets', () => {
    // With an independent 15% roll per bucket, a run of 8 has probability
    // ~2.6e-7 per start; across 400 tables x 48 buckets that is ~0.005
    // expected runs. The old walking hash produced runs of ~15 (30 hours) by
    // construction. Deterministic inputs, so this is a pin, not a dice roll.
    let worstRun = 0;
    for (const id of tables) {
      let run = 0;
      for (let b = 0; b < 48; b++) {
        if (cashTableHeldEmpty(id, T0 + b * EMPTY_BUCKET_MS)) {
          run++;
          worstRun = Math.max(worstRun, run);
        } else {
          run = 0;
        }
      }
    }
    expect(worstRun).toBeLessThan(8);
  });

  it('consecutive buckets are not correlated: transition rates match independence', () => {
    // Under independence, P(held in bucket b+1 | held in bucket b) is just
    // the base rate (~15%). Under the old +1-walk it was near 100% until the
    // band was exhausted. Allow generous sampling slack either side.
    let heldNow = 0;
    let heldBoth = 0;
    for (const id of tables) {
      for (let b = 0; b < 40; b++) {
        if (!cashTableHeldEmpty(id, T0 + b * EMPTY_BUCKET_MS)) continue;
        heldNow++;
        if (cashTableHeldEmpty(id, T0 + (b + 1) * EMPTY_BUCKET_MS)) heldBoth++;
      }
    }
    expect(heldNow).toBeGreaterThan(100); // the hold itself still happens
    const conditional = heldBoth / heldNow;
    expect(conditional).toBeGreaterThan(0.05);
    expect(conditional).toBeLessThan(0.3);
  });

  it('every bucket holds roughly the requested fraction of the floor', () => {
    for (let b = 0; b < 12; b++) {
      const now = T0 + b * EMPTY_BUCKET_MS;
      const frac = tables.filter((id) => cashTableHeldEmpty(id, now)).length / tables.length;
      expect(frac, `bucket ${b}`).toBeGreaterThan(0.07);
      expect(frac, `bucket ${b}`).toBeLessThan(CASH_EMPTY_FRACTION + 0.1);
    }
  });
});

describe('a variant must never go fully dark (Dan, 2026-08-30)', () => {
  it('the only open table for its variant config is never held empty', () => {
    // Find a table the hash WOULD hold, mark it sole-open, and the hold must
    // yield. Checked across many buckets: sole-open beats every roll.
    const held = tables.find((id) => cashTableHeldEmpty(id, T0))!;
    expect(held).toBeTruthy();
    setSoleOpenCashTables([held]);
    for (let b = 0; b < 24; b++) {
      expect(cashTableHeldEmpty(held, T0 + b * EMPTY_BUCKET_MS)).toBe(false);
    }
    /* 2026-09-02: occupancyTargetFor no longer consults the hold at all —
       the cash occupancy law (75% packed / 25% sporadic-one-to-full) has no
       held-empty class, so its floor is 1, not 2. cashTableHeldEmpty itself
       and the sole-open registry keep their contract, pinned above. */
    const { seatTarget, vibe } = occupancyTargetFor(held, 6, false, T0);
    expect(vibe).not.toBe('empty');
    expect(seatTarget).toBeGreaterThanOrEqual(1);
  });

  it('the registry replaces, not accumulates, and clearing restores the hold', () => {
    const held = tables.find((id) => cashTableHeldEmpty(id, T0))!;
    setSoleOpenCashTables([held]);
    expect(cashTableHeldEmpty(held, T0)).toBe(false);
    setSoleOpenCashTables(['some-other-table']);
    expect(cashTableHeldEmpty(held, T0)).toBe(true);
    setSoleOpenCashTables([]);
    expect(cashTableHeldEmpty(held, T0)).toBe(true);
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
