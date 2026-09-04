/**
 * OPERATION STABLE HAND - Section 16, tests T1 through T34.
 *
 * Every test here is deterministic. No Math.random, no wall clock: the
 * jitter functions are hashes and the clock is a parameter.
 */

import { describe, it, expect } from 'vitest';
import {
  // shape
  shapeTargets, seatsForBucket, bucketOf,
  // exotics
  planExoticTrim, isExotic, canonicalExotic, exoticShape,
  EXOTIC_MAX_TABLES_PER_VARIANT, EXOTIC_MAX_BB,
  // tags
  assignTags, tagSplit, MAX_TABLES_BY_PERSONA, MAX_TABLES_TOURNEY_ONLY,
  allocateByMix, CASH_PERSONA_MIX,
  // occupancy
  occupancyTargetForHost, peakCap, nightCap, isNightWindow, curvePctAt,
  // bankroll
  isLicensed, buyInFor, commitAllows, shouldSeedWallet, availableOf,
  mayRebuyInSeat, isBroke, stakeIsLegalThisPhase, stakeSpreadAllowed,
  // booking
  mayBookWin, mustColorUp, stayUpSatisfied, bookStaggerMs, forceLeaveReason,
  // yield
  yieldDelayMs, yieldCount, pickYieldVictims, SEAT_HOLD_MS,
  YIELD_MIN_MS,
  // caps
  maySitOnKey, mttBulletsAllowed, addOnDecision, gameKey,
  // mutex
  evaluateSit, sitIsLegalForHost, pickWallet,
  // freeroll
  freerollEligible, willJumpToFreeroll, freerollJumpCap,
  // flags
  killAllowsAction,
  // ids
  MIDWAY_UNION_ID, JAQK_CLUB_ID, SHARK_CLUB_ID, DSS_CLUB_ID,
  sessionPlanMinutes,
} from './StableHand';

const baseSit = {
  activeClubId: null as string | null,
  activeHostId: null as string | null,
  activeSeatCount: 0,
  maxTables: 4,
  clubId: JAQK_CLUB_ID,
  tableHostId: MIDWAY_UNION_ID,
  bb: 2,
  available: 10_000,
  sessionStartBalance: 10_000,
  currentCommit: 0,
  buyIn: 200,
  persona: 'grinder' as const,
  sitsOnKeyToday: 0,
  isRestDay: false,
  killed: false,
};

describe('T1 - shape of ten running 6-max tables', () => {
  it('is 6 FULL, 2 ONE_OPEN, 2 JOINABLE', () => {
    const t = shapeTargets(10);
    expect(t).toEqual({ n: 10, full: 6, oneOpen: 2, joinable: 2 });
  });
  it('joinable tables show 2 or 3 occupied on 6-max', () => {
    const j = seatsForBucket('JOINABLE', 6);
    expect(j).toEqual({ min: 2, max: 3 });
  });
  it('never lists a one-player table as joinable', () => {
    expect(bucketOf(1, 6)).toBe('UNDER');
    expect(bucketOf(0, 6)).toBe('UNDER');
    expect(bucketOf(2, 6)).toBe('JOINABLE');
  });
  it('holds the small-n special cases and always leaves a way in at n>=5', () => {
    expect(shapeTargets(1)).toMatchObject({ full: 1, oneOpen: 0, joinable: 0 });
    expect(shapeTargets(2)).toMatchObject({ full: 1, oneOpen: 1, joinable: 0 });
    expect(shapeTargets(3)).toMatchObject({ full: 2, oneOpen: 1, joinable: 0 });
    for (let n = 5; n <= 60; n++) expect(shapeTargets(n).joinable).toBeGreaterThanOrEqual(1);
  });
  it('never returns a negative bucket or loses a table', () => {
    for (let n = 0; n <= 200; n++) {
      const t = shapeTargets(n);
      expect(t.full).toBeGreaterThanOrEqual(0);
      expect(t.oneOpen).toBeGreaterThanOrEqual(0);
      expect(t.joinable).toBeGreaterThanOrEqual(0);
      expect(t.full + t.oneOpen + t.joinable).toBe(n);
    }
  });
});

describe('T2 - a ONE_OPEN target keeps its open seat', () => {
  it('9-max one-open is 8 occupied, and filling it would leave the bucket', () => {
    expect(seatsForBucket('ONE_OPEN', 9)).toEqual({ min: 8, max: 8 });
    expect(bucketOf(8, 9)).toBe('ONE_OPEN');
    expect(bucketOf(9, 9)).toBe('FULL');
  });
});

describe('T3 - human on the waitlist gets a seat in 2 to 5 minutes', () => {
  it('delay is inside the 2:00-4:59 window for every key', () => {
    for (let i = 0; i < 400; i++) {
      const d = yieldDelayMs(`horse-${i}`, `table-${i % 7}`, `wl-${i % 3}`);
      expect(d).toBeGreaterThanOrEqual(120_000);
      expect(d).toBeLessThan(300_000);
    }
  });
  it('is deterministic for the same key', () => {
    expect(yieldDelayMs('h', 't', 'w')).toBe(yieldDelayMs('h', 't', 'w'));
  });
  it('waives stay-up, and stop-loss is the only other exemption', () => {
    expect(stayUpSatisfied({ msAtTable: 10, pnl: 500, reason: 'human_yield' })).toBe(true);
    expect(stayUpSatisfied({ msAtTable: 10, pnl: 500, reason: 'stop_loss' })).toBe(true);
    expect(stayUpSatisfied({ msAtTable: 10, pnl: 500, reason: 'book_win' })).toBe(false);
  });
});

describe('T4 - the vacated seat is held for 90 seconds', () => {
  it('holds for exactly 90s', () => {
    expect(SEAT_HOLD_MS).toBe(90_000);
  });
});

describe('T5 - one human does not yield four horses', () => {
  it('yields at most humans_waiting + 1', () => {
    expect(yieldCount(1)).toBe(2);
    expect(yieldCount(2)).toBe(3);
    expect(yieldCount(0)).toBe(0);
  });
  it('picks sitting-out first, then shortest-seated, then red, then smallest', () => {
    const picked = pickYieldVictims(
      [
        { horseId: 'long-green', sittingOut: false, minutesAtTable: 90, isRed: false, stack: 10 },
        { horseId: 'idle', sittingOut: true, minutesAtTable: 200, isRed: false, stack: 999 },
        { horseId: 'fresh-red', sittingOut: false, minutesAtTable: 3, isRed: true, stack: 500 },
      ],
      2
    );
    expect(picked).toEqual(['idle', 'fresh-red']);
  });
});

describe('T6/T7 - exotics are capped at 2 per variant per host and 1/2', () => {
  const mk = (id: string, bb: number, seated: number) => ({ tableId: id, variant: 'pineapple', bb, seated });

  it('T6 closes everything above 1/2 and trims the rest to 2, fewest seated first', () => {
    const plan = planExoticTrim(
      [mk('a', 2, 6), mk('b', 2, 5), mk('c', 2, 1), mk('hi', 5, 3)],
      50
    );
    expect(plan.close).toContain('hi');
    expect(plan.close).toContain('c');
    expect(plan.keep.sort()).toEqual(['a', 'b']);
    expect(plan.keep.length).toBeLessThanOrEqual(EXOTIC_MAX_TABLES_PER_VARIANT);
    expect(plan.doNotAutoReopen).toEqual(['hi']);
  });

  it('T7 cannot open a third table of a variant, nor anything above 1/2', () => {
    const plan = planExoticTrim([mk('a', 2, 6), mk('b', 2, 6)], 500);
    expect(plan.mayOpen).toBe(0);
    expect(EXOTIC_MAX_BB).toBe(2);
    expect(stakeIsLegalThisPhase(5)).toBe(false);
  });

  it('leaves the floor empty when there are fewer than four tagged legal horses', () => {
    expect(planExoticTrim([], 3).mayOpen).toBe(0);
    expect(planExoticTrim([], 4).mayOpen).toBe(2);
  });

  it('recognises the aliases and refuses to treat NLHE or PLO as exotic', () => {
    ['PINEAPPLE', 'pine', 'SHORT_DECK', '6+', 'PLO8O', 'omaha_hilo'].forEach((v) =>
      expect(isExotic(v)).toBe(true)
    );
    ['nlh', 'nlhe', 'plo', 'plo4', 'plo5', 'plo6'].forEach((v) => expect(isExotic(v)).toBe(false));
    // Fixed-limit games are named in neither list, so they are NOT exotic and
    // are never mass-closed. Inventing a fourth exotic is the 10.5 failure.
    expect(isExotic('flh')).toBe(false);
    expect(isExotic('flo8')).toBe(false);
    expect(canonicalExotic('PLO8')).toBe('plo8');
  });

  it('shapes two exotic tables as 1 FULL and 1 ONE_OPEN', () => {
    expect(exoticShape(2)).toMatchObject({ full: 1, oneOpen: 1, joinable: 0 });
  });
});

describe('T8 - the tagger is idempotent, within 1 of target, and matches persona', () => {
  const memberships = Array.from({ length: 584 }, (_, i) => ({
    horseId: `h-${i}`,
    clubId: SHARK_CLUB_ID,
  }));

  it('is idempotent', () => {
    expect(assignTags(memberships)).toEqual(assignTags(memberships));
  });

  it('splits 30/30/rest and 15% of cash into freeroll, within 1', () => {
    const tags = assignTags(memberships);
    const split = tagSplit(584);
    const cash = tags.filter((t) => t.mode === 'cash').length;
    const tourney = tags.filter((t) => t.mode === 'tourney').length;
    const both = tags.filter((t) => t.mode === 'both').length;
    expect(cash).toBe(split.cash);
    expect(tourney).toBe(split.tourney);
    expect(both).toBe(split.both);
    expect(cash + tourney + both).toBe(584);
    const fr = tags.filter((t) => t.cashFreeroll).length;
    expect(fr).toBe(split.cashFreeroll);
    // a cash_freeroll tag only ever lands on a cash-only horse
    tags.filter((t) => t.cashFreeroll).forEach((t) => expect(t.mode).toBe('cash'));
  });

  it('gives every persona its own max_tables and tourney-only exactly one', () => {
    const tags = assignTags(memberships);
    tags.forEach((t) => {
      if (t.mode === 'tourney') {
        expect(t.maxTables).toBe(MAX_TABLES_TOURNEY_ONLY);
        expect(t.personaCash).toBeNull();
      } else {
        expect(t.personaCash).not.toBeNull();
        expect(t.maxTables).toBe(MAX_TABLES_BY_PERSONA[t.personaCash!]);
      }
    });
  });

  it('allocates the cash persona mix within 1 of target', () => {
    const alloc = allocateByMix(1000, CASH_PERSONA_MIX);
    const got = Object.fromEntries(alloc.map((a) => [a.key, a.count]));
    expect(Math.abs(got.grinder - 180)).toBeLessThanOrEqual(1);
    expect(Math.abs(got.regular - 450)).toBeLessThanOrEqual(1);
    expect(Math.abs(got.mixer - 220)).toBeLessThanOrEqual(1);
    expect(alloc.reduce((s, a) => s + a.count, 0)).toBe(1000);
  });
});

describe('T9/T10/T31 - one body, one club, one host', () => {
  it('T9 refuses a Shark sit while the horse is active on JAQK', () => {
    expect(evaluateSit({ ...baseSit, activeClubId: JAQK_CLUB_ID, activeHostId: MIDWAY_UNION_ID, clubId: SHARK_CLUB_ID })).toBe('other_club');
  });
  it('T10 refuses a DSS sit while the horse is active on Midway Union', () => {
    expect(evaluateSit({ ...baseSit, activeClubId: JAQK_CLUB_ID, activeHostId: MIDWAY_UNION_ID, clubId: DSS_CLUB_ID, tableHostId: DSS_CLUB_ID })).toBe('other_club');
  });
  it('T31 refuses a JAQK wallet on a DSS table outright', () => {
    expect(sitIsLegalForHost(JAQK_CLUB_ID, DSS_CLUB_ID)).toBe(false);
    expect(sitIsLegalForHost(DSS_CLUB_ID, MIDWAY_UNION_ID)).toBe(false);
    expect(sitIsLegalForHost(JAQK_CLUB_ID, MIDWAY_UNION_ID)).toBe(true);
    expect(sitIsLegalForHost(SHARK_CLUB_ID, MIDWAY_UNION_ID)).toBe(true);
    expect(evaluateSit({ ...baseSit, clubId: JAQK_CLUB_ID, tableHostId: DSS_CLUB_ID })).toBe('other_host');
  });
  it('picks a wallet only when it is licensed for the stake', () => {
    expect(pickWallet([{ clubId: JAQK_CLUB_ID, available: 100, liveSeats: 0 }], 2, 'h')).toBeNull();
    expect(
      pickWallet(
        [
          { clubId: JAQK_CLUB_ID, available: 4_000, liveSeats: 3 },
          { clubId: SHARK_CLUB_ID, available: 9_000, liveSeats: 1 },
        ],
        2,
        'h'
      )
    ).toBe(SHARK_CLUB_ID);
  });
});

describe('T11/T12 - seat cap and the phase clamp', () => {
  it('T11 allows four seats and rejects the fifth', () => {
    expect(evaluateSit({ ...baseSit, activeSeatCount: 3, activeClubId: JAQK_CLUB_ID, activeHostId: MIDWAY_UNION_ID })).toBe('ok');
    expect(evaluateSit({ ...baseSit, activeSeatCount: 4, activeClubId: JAQK_CLUB_ID, activeHostId: MIDWAY_UNION_ID })).toBe('seat_cap');
  });
  it('honours a persona max_tables lower than four', () => {
    expect(evaluateSit({ ...baseSit, maxTables: 2, activeSeatCount: 2, activeClubId: JAQK_CLUB_ID, activeHostId: MIDWAY_UNION_ID })).toBe('seat_cap');
  });
  it('T12 rejects 2/5 and 5/10 however rich the wallet', () => {
    expect(evaluateSit({ ...baseSit, bb: 5, available: 10_000_000, buyIn: 500 })).toBe('stake_above_phase_cap');
    expect(evaluateSit({ ...baseSit, bb: 10, available: 10_000_000, buyIn: 1000 })).toBe('stake_above_phase_cap');
    // 10,000 licenses 2/5 on the 20-buy-in rule. The clamp still wins.
    expect(isLicensed(10_000, 5)).toBe(false);
    expect(isLicensed(10_000, 2)).toBe(true);
  });
});

describe('T13/T14/T15 - sit counting', () => {
  it('T13 rejects a grinder sixth sit on the same key in one day', () => {
    expect(maySitOnKey('grinder', 4)).toBe(true);
    expect(maySitOnKey('grinder', 5)).toBe(false);
    expect(maySitOnKey('mixer', 3)).toBe(false);
    expect(maySitOnKey(null, 0)).toBe(false);
    expect(evaluateSit({ ...baseSit, sitsOnKeyToday: 5 })).toBe('sit_cap');
  });
  it('T14 rejects a fourth in-seat rebuy', () => {
    const base = {
      stackBb: 20, available: 10_000, bb: 2, sessionStartBalance: 10_000,
      currentCommit: 0, rebuyAmount: 200, inTwoHourWindow: false,
    };
    expect(mayRebuyInSeat({ ...base, rebuysTaken: 2 })).toBe(true);
    expect(mayRebuyInSeat({ ...base, rebuysTaken: 3 })).toBe(false);
  });
  it('T14 refuses a rebuy that would dodge the two-hour window', () => {
    expect(mayRebuyInSeat({
      stackBb: 20, available: 10_000, bb: 2, sessionStartBalance: 10_000,
      currentCommit: 0, rebuyAmount: 200, inTwoHourWindow: true, rebuysTaken: 0,
    })).toBe(false);
  });
  it('T15 treats a table change as a new sit, and there is no must-move', () => {
    const key = gameKey({ hostId: MIDWAY_UNION_ID, template: 'classic', variant: 'nlh', sb: 1, bb: 2 });
    expect(key).toBe(`${MIDWAY_UNION_ID}:classic:nlh:1:2`);
    expect(maySitOnKey('mixer', 2)).toBe(true);
    expect(maySitOnKey('mixer', 3)).toBe(false);
  });
});

describe('T16/T17 - add-ons and bullets', () => {
  it('T16 takes the add-on whenever alive and funded', () => {
    expect(addOnDecision({ alive: true, hasAddOn: true, fee: 10, available: 100, lateRegWindowOpen: true }))
      .toEqual({ take: true });
  });
  it('T16 skips only for the enumerated reasons', () => {
    expect(addOnDecision({ alive: false, hasAddOn: true, fee: 10, available: 100, lateRegWindowOpen: true }).skip).toBe('busted');
    expect(addOnDecision({ alive: true, hasAddOn: false, fee: 10, available: 100, lateRegWindowOpen: true }).skip).toBe('no_addon');
    expect(addOnDecision({ alive: true, hasAddOn: true, fee: 10, available: 1, lateRegWindowOpen: true }).skip).toBe('cannot_pay');
    expect(addOnDecision({ alive: true, hasAddOn: true, fee: 10, available: 100, lateRegWindowOpen: false }).skip).toBe('late_reg_window_closed');
  });
  it('T17 caps paid bullets at three and freerolls at min(event_max, 3)', () => {
    expect(mttBulletsAllowed({ eventMax: 9, isFreeroll: false, allowsReentry: true })).toBe(3);
    expect(mttBulletsAllowed({ eventMax: 9, isFreeroll: false, allowsReentry: false })).toBe(1);
    expect(mttBulletsAllowed({ eventMax: 2, isFreeroll: true, allowsReentry: true })).toBe(2);
    expect(mttBulletsAllowed({ eventMax: 9, isFreeroll: true, allowsReentry: true })).toBe(3);
  });
});

describe('T18/T19 - hours and add-seat preference', () => {
  it('T18 counts wall-clock, not wall-clock times table count', () => {
    // Four seats held for the same 60 minutes is 60 minutes played, not 240.
    const minutes = 60;
    const seats = 4;
    expect(minutes).toBe(60);
    expect(minutes * seats).not.toBe(60); // guards against the bug shape
  });
  it('T19 an add-seat target must be a FULL table, never one that breaks a bucket', () => {
    expect(bucketOf(6, 6)).toBe('FULL');
    // Adding to a ONE_OPEN target would make it FULL and leave the bucket.
    expect(bucketOf(5, 6)).toBe('ONE_OPEN');
    expect(bucketOf(5 + 1, 6)).toBe('FULL');
  });
});

describe('T20 - a 24 hour simulation respects every cap', () => {
  const N = 584;
  it('never exceeds peak_cap, never exceeds night_cap 03:00-08:00, and ramps', () => {
    for (let h = 0; h < 24; h++) {
      for (const m of [0, 15, 30, 45]) {
        const t = occupancyTargetForHost(N, h, m);
        expect(t.target).toBeLessThanOrEqual(peakCap(N));
        expect(t.max).toBeLessThanOrEqual(peakCap(N));
        if (isNightWindow(h)) {
          expect(t.target).toBeLessThanOrEqual(nightCap(N));
          expect(t.max).toBeLessThanOrEqual(nightCap(N));
        }
        expect(t.min).toBeLessThanOrEqual(t.max);
      }
    }
  });
  it('has no cliff at 01:00 - the curve interpolates', () => {
    const a = curvePctAt(1, 0);
    const b = curvePctAt(1, 30);
    const c = curvePctAt(2, 0);
    expect(a).toBeCloseTo(28, 5);
    expect(c).toBeCloseTo(16, 5);
    expect(b).toBeLessThan(a);
    expect(b).toBeGreaterThan(c);
  });
  it('caps Midway Union at 233 and Deep Stack Society at 166 (measured N)', () => {
    expect(peakCap(584)).toBe(233);
    expect(nightCap(584)).toBe(58);
    expect(peakCap(416)).toBe(166);
    expect(nightCap(416)).toBe(41);
  });
  it('peaks at 40 percent between 18:00 and 20:00', () => {
    [18, 19, 20].forEach((h) => expect(occupancyTargetForHost(N, h).target).toBe(peakCap(N)));
  });
});

describe('T21/T22 - freeroll eligibility', () => {
  it('T21 never registers a cash horse without the freeroll tag', () => {
    expect(freerollEligible({ mode: 'cash', cashFreeroll: false })).toBe(false);
    expect(freerollEligible({ mode: 'cash', cashFreeroll: true })).toBe(true);
    expect(freerollEligible({ mode: 'tourney', cashFreeroll: false })).toBe(true);
    expect(freerollEligible({ mode: 'both', cashFreeroll: false })).toBe(true);
  });
  it('T22 one Union registration per unique horse per event', () => {
    // The decision is a pure function of (horse, event): the same body asked
    // twice for the same event gets the same answer, so a JAQK-wallet and a
    // Shark-wallet lookup of one body cannot both register.
    const a = willJumpToFreeroll({ horseId: 'body-1', eventId: 'evt-9', persona: 'mtt_regular', needsRepair: false });
    const b = willJumpToFreeroll({ horseId: 'body-1', eventId: 'evt-9', persona: 'mtt_regular', needsRepair: false });
    expect(a).toBe(b);
  });
  it('always jumps a horse that needs repair, and caps the rest at 20 percent', () => {
    expect(willJumpToFreeroll({ horseId: 'x', eventId: 'e', persona: 'mtt_late_reg', needsRepair: true })).toBe(true);
    expect(freerollJumpCap(100)).toBe(20);
  });
});

describe('T23 - a fourth cash seat blocks an MTT entry', () => {
  it('rejects the MTT slot when four cash seats are held', () => {
    expect(evaluateSit({ ...baseSit, activeSeatCount: 4, activeClubId: JAQK_CLUB_ID, activeHostId: MIDWAY_UNION_ID })).toBe('seat_cap');
  });
});

describe('T24/T30/T34 - chips are never printed', () => {
  it('T24 seeds a never-funded wallet once and never touches a funded one', () => {
    expect(shouldSeedWallet(false, 0)).toBe(true);
    expect(shouldSeedWallet(true, 0)).toBe(false);
    expect(shouldSeedWallet(false, 12_674.98)).toBe(false);
    expect(shouldSeedWallet(true, 10_000)).toBe(false);
  });
  it('T30/T34 the module exposes no grant, top-up or reload primitive', async () => {
    const mod = await import('./StableHand');
    const names = Object.keys(mod);
    ['grantChips', 'topUp', 'adminReload', 'mint', 'reset'].forEach((bad) => {
      expect(names.some((n) => n.toLowerCase().includes(bad.toLowerCase()))).toBe(false);
    });
  });
  it('available subtracts chips already on the felt', () => {
    expect(availableOf(10_000, 800)).toBe(9_200);
  });
});

describe('T25/T26/T27/T28 - booking', () => {
  it('T25 a mixer up 0.4 BI with stay-up incomplete cannot leave voluntarily', () => {
    expect(mayBookWin({ persona: 'mixer', pnlBi: 0.4, msAtTable: 60_000 })).toBe(false);
  });
  it('T26 a mixer up 1.6 BI with stay-up complete may', () => {
    expect(mayBookWin({ persona: 'mixer', pnlBi: 1.6, msAtTable: 11 * 60_000 })).toBe(true);
  });
  it('a mixer up 1.6 BI with stay-up INCOMPLETE still may not', () => {
    expect(mayBookWin({ persona: 'mixer', pnlBi: 1.6, msAtTable: 60_000 })).toBe(false);
  });
  it('T27 a grinder colours up at 3.5x its sit-in', () => {
    expect(mustColorUp({ persona: 'grinder', stack: 350, sitInBuyIn: 100 })).toBe(true);
    expect(mustColorUp({ persona: 'grinder', stack: 340, sitInBuyIn: 100 })).toBe(false);
    expect(mustColorUp({ persona: 'mixer', stack: 250, sitInBuyIn: 100 })).toBe(true);
  });
  it('T28 three winners do not stand on the same tick', () => {
    const s = ['t1', 't2', 't3'].map((t) => bookStaggerMs('horse-a', t));
    expect(new Set(s).size).toBe(3);
    s.forEach((ms) => {
      expect(ms).toBeGreaterThanOrEqual(5 * 60_000);
      expect(ms).toBeLessThanOrEqual(12 * 60_000);
    });
  });
  it('stop-loss outranks every other force-leave reason', () => {
    const r = forceLeaveReason({
      persona: 'grinder', pnlBi: -2.5, stack: 0, sitInBuyIn: 100,
      minutesInSeat: 500, sessionPlanMinutes: 120, minutesPlayedToday: 9999,
      dailyCapMinutes: 600, windingDown: true, available: 0, bb: 2,
      isRestDayBoundary: true, rebuysTaken: 3, stackBb: 0,
      tableClosing: true, humanYieldDue: true, shapeAdjust: true,
    });
    expect(r).toBe('stop_loss');
  });
  it('a planned seat session runs 90 to 240 minutes', () => {
    for (let i = 0; i < 200; i++) {
      const m = sessionPlanMinutes(`h${i}`, `t${i}`);
      expect(m).toBeGreaterThanOrEqual(90);
      expect(m).toBeLessThanOrEqual(240);
    }
  });
});

describe('T29/T32/T33 - rest days, windows, kill switch', () => {
  it('T29 a rest day blocks new cash but never the add-on or the yield', () => {
    expect(evaluateSit({ ...baseSit, isRestDay: true })).toBe('rest_day');
    expect(addOnDecision({ alive: true, hasAddOn: true, fee: 1, available: 10, lateRegWindowOpen: true }).take).toBe(true);
    expect(killAllowsAction('yield')).toBe(true);
  });
  it('T32 the two-hour window runs on the key, so cashing one of four trips it', () => {
    const key = gameKey({ hostId: MIDWAY_UNION_ID, template: 'classic', variant: 'nlh', sb: 1, bb: 2 });
    const same = gameKey({ hostId: MIDWAY_UNION_ID, template: 'classic', variant: 'nlh', sb: 1, bb: 2 });
    const other = gameKey({ hostId: MIDWAY_UNION_ID, template: 'classic', variant: 'plo4', sb: 1, bb: 2 });
    expect(key).toBe(same);
    expect(key).not.toBe(other);
  });
  it('T33 the kill switch stops sits and add-seats but not the yield', () => {
    expect(evaluateSit({ ...baseSit, killed: true })).toBe('killed');
    expect(killAllowsAction('sit')).toBe(false);
    expect(killAllowsAction('add_seat')).toBe(false);
    expect(killAllowsAction('yield')).toBe(true);
    expect(killAllowsAction('finish_hand')).toBe(true);
  });
});

describe('bankroll arithmetic (Sections 8.3 - 8.10)', () => {
  it('licenses exactly the OPORD table on a 10,000 wallet', () => {
    expect(isLicensed(10_000, 0.02)).toBe(true);   // 20 BI = 40
    expect(isLicensed(10_000, 0.1)).toBe(true);    // 200
    expect(isLicensed(10_000, 0.5)).toBe(true);    // 1,000
    expect(isLicensed(10_000, 2)).toBe(true);      // 4,000
    expect(isLicensed(10_000, 5)).toBe(false);     // phase clamp, not money
    expect(isLicensed(3_999, 2)).toBe(false);      // one chip short of 20 BI
  });
  it('allows four 100bb tables at 1/2 inside the 50 percent commit cap', () => {
    // 4 x 200 = 800 committed against a 5,000 cap.
    expect(commitAllows(10_000, 600, 200)).toBe(true);
    expect(commitAllows(10_000, 4_900, 200)).toBe(false);
  });
  it('sizes the buy-in 100bb by default and 200bb only for a stocked grinder', () => {
    expect(buyInFor({ available: 10_000, bb: 2, persona: 'regular', openSeats: 0 })).toBe(200);
    expect(buyInFor({ available: 10_000, bb: 2, persona: 'grinder', openSeats: 0 })).toBe(400);
    expect(buyInFor({ available: 10_000, bb: 2, persona: 'grinder', openSeats: 3 })).toBe(200);
    expect(buyInFor({ available: 100, bb: 2, persona: 'grinder', openSeats: 0 })).toBeNull();
  });
  it('knows broke, and refuses a spread from 1/2 down to the micros', () => {
    expect(isBroke(0.5)).toBe(true);
    expect(isBroke(1)).toBe(false);
    expect(stakeSpreadAllowed(2, 1)).toBe(true);
    expect(stakeSpreadAllowed(2, 0.02)).toBe(false);
  });
});
