import { describe, it, expect } from 'vitest';
import { shHash } from './StableHand.js';
import {
  FREE_BUY_SLOT_MINUTE,
  FREE_BUY_HALF_HOUR_SLOTS_FROM_MS,
  freeBuySlotTime,
  FREE_BUY_TIERS,
  freeBuyConfigForSlot,
  FREE_BUY_SLOTS,
  slotForChicagoHour,
  dailyGuaranteePerHost,
  overlayFor,
  addOnWindowFor,
  addOnOpen,
  rebuysOpen,
  ADDON_BREAK_MS,
  horseAddsOnImmediately,
  horseAddOnTiming,
  horseTakesAddOn,
  HORSE_ADDON_PARTICIPATION_RATE,
  horseRebuyAllowance,
  horseMayRebuy,
  HORSE_ADDON_IMMEDIATE_RATE,
  HORSE_MAX_REBUYS,
  projectedCollected,
} from './FreeBuy.js';

const std = FREE_BUY_TIERS.standard;
const feat = FREE_BUY_TIERS.feature;

describe('the Free Buy tiers carry the current owner guarantees', () => {
  it('standard tier: free entry, 250 guaranteed (owner October 22), 1 rebuy, 1 add-on', () => {
    expect(std).toMatchObject({
      guarantee: 250,
      buyIn: 0,
      startingChips: 3000,
      rebuyCost: 1,
      addOnCost: 1,
      addOnChips: 10000,
      lateRegMinutes: 60,
      blindStructure: 'FREE_BUY',
    });
  });
  it('feature tier: same shape, 500 guaranteed, 1 rebuy and 1 add-on (owner October 22)', () => {
    expect(feat).toMatchObject({
      guarantee: 500,
      buyIn: 0,
      startingChips: 3000,
      rebuyCost: 1,
      addOnCost: 1,
      addOnChips: 10000,
      lateRegMinutes: 60,
      blindStructure: 'FREE_BUY',
    });
  });
  it('the first entry is free in both tiers - that is what makes it a Free Buy', () => {
    expect(std.buyIn).toBe(0);
    expect(feat.buyIn).toBe(0);
  });
  it('an add-on is worth more than three starting stacks', () => {
    expect(std.addOnChips).toBeGreaterThan(std.startingChips * 3);
  });
});

describe('the daily schedule', () => {
  it('runs five events every four hours from 08:30 Chicago, on the half hour (Dan 2026-10-16)', () => {
    expect(FREE_BUY_SLOTS.map((s) => s.chicagoHour)).toEqual([8, 12, 16, 20, 0]);
    expect(FREE_BUY_SLOTS).toHaveLength(5);
    expect(FREE_BUY_SLOT_MINUTE).toBe(30);
    expect(FREE_BUY_SLOTS.map(freeBuySlotTime)).toEqual([
      '08:30',
      '12:30',
      '16:30',
      '20:30',
      '00:30',
    ]);
  });
  it('makes 20:00 the feature and every other slot standard', () => {
    expect(slotForChicagoHour(20)?.tier).toBe('feature');
    [8, 12, 16, 0].forEach((h) => expect(slotForChicagoHour(h)?.tier).toBe('standard'));
    expect(slotForChicagoHour(9)).toBeNull();
  });
  it('guarantees 2,000 per host per day', () => {
    expect(dailyGuaranteePerHost()).toBe(2000);
  });
  it('and 4,000 across both hosts - the number worth saying out loud', () => {
    expect(dailyGuaranteePerHost() * 2).toBe(4000);
  });
  it('runs four-hourly from 08:30 to 00:30, then leaves the night dark', () => {
    const hours = FREE_BUY_SLOTS.map((s) => s.chicagoHour);
    const inOrder = [8, 12, 16, 20, 24];
    expect(inOrder.slice(1).map((h, i) => h - inOrder[i])).toEqual([4, 4, 4, 4]);
    expect(hours).toEqual([8, 12, 16, 20, 0]);
  });
});

describe('the guarantee is a ceiling, not a cost', () => {
  it('pays only the shortfall', () => {
    expect(overlayFor(250, 0)).toBe(250);
    expect(overlayFor(250, 100)).toBe(150);
    expect(overlayFor(250, 250)).toBe(0);
    expect(overlayFor(250, 900)).toBe(0);
  });
  it('a well-attended field can retire the guarantee entirely', () => {
    const collected = projectedCollected({
      entrants: 150,
      expectedRebuysPerEntrant: 2.5,
      addOnRate: 1.0,
      cfg: std,
    });
    expect(collected).toBe(525);
    expect(overlayFor(std.guarantee, collected)).toBe(0);
  });
});

describe('the add-on window is ONE window, open from the start', () => {
  const start = 1_000_000;
  const w = addOnWindowFor(start, std);

  it('opens the instant the event starts, so a player can add on at sit-down', () => {
    expect(w.opensAtMs).toBe(start);
    expect(addOnOpen(start, w)).toBe(true);
  });
  it('is still open at the break, one hour later', () => {
    expect(addOnOpen(start + 60 * 60_000, w)).toBe(true);
  });
  it('closes after the add-on break that follows late registration', () => {
    expect(w.closesAtMs).toBe(start + 60 * 60_000 + ADDON_BREAK_MS);
    expect(addOnOpen(w.closesAtMs, w)).toBe(false);
    expect(addOnOpen(w.closesAtMs + 1, w)).toBe(false);
  });
  it('is shut before the event begins', () => {
    expect(addOnOpen(start - 1, w)).toBe(false);
  });
  it('closes rebuys and late reg together at the hour', () => {
    expect(rebuysOpen(start, start, std)).toBe(true);
    expect(rebuysOpen(start + 59 * 60_000, start, std)).toBe(true);
    expect(rebuysOpen(start + 60 * 60_000, start, std)).toBe(false);
  });
  it('leaves the add-on open for a minute after rebuys shut', () => {
    const justAfterRebuys = start + 60 * 60_000;
    expect(rebuysOpen(justAfterRebuys, start, std)).toBe(false);
    expect(addOnOpen(justAfterRebuys, w)).toBe(true);
  });
});

describe('74 percent of surviving funded horses add on', () => {
  const ids = Array.from({ length: 2000 }, (_, i) => `h-${i}`);

  it('35% take it immediately, within sampling tolerance', () => {
    const immediate = ids.filter((h) => horseAddsOnImmediately(h, 'evt-1')).length;
    const rate = immediate / ids.length;
    expect(rate).toBeGreaterThan(HORSE_ADDON_IMMEDIATE_RATE - 0.04);
    expect(rate).toBeLessThan(HORSE_ADDON_IMMEDIATE_RATE + 0.04);
  });

  it('selects a stable random 74 percent cohort for the event', () => {
    expect(HORSE_ADDON_PARTICIPATION_RATE).toBe(0.74);
    const chosen = ids.filter((h) => horseTakesAddOn(h, 'evt-1'));
    expect(chosen.length / ids.length).toBeGreaterThan(0.71);
    expect(chosen.length / ids.length).toBeLessThan(0.77);
    for (const id of ids) {
      expect(horseAddOnTiming(id, 'evt-1', true) !== 'declined').toBe(horseTakesAddOn(id, 'evt-1'));
      expect(horseTakesAddOn(id, 'evt-1')).toBe(horseTakesAddOn(id, 'evt-1'));
    }
  });

  it('a selected horse waiting for the break cannot add on after busting', () => {
    const late = ids.filter(
      (h) => horseTakesAddOn(h, 'evt-1') && !horseAddsOnImmediately(h, 'evt-1')
    );
    expect(horseAddOnTiming(late[0], 'evt-1', false)).toBe('busted_before_break');
  });

  it('accepts exactly 740 of the 1000 participation buckets, including the boundary', () => {
    const buckets = new Map<number, string>();
    for (let i = 0; buckets.size < 1000 && i < 20000; i++) {
      const id = `boundary-horse-${i}`;
      buckets.set(shHash(id, 'event', 'addon-participation') % 1000, id);
    }
    expect(buckets.size).toBe(1000);
    for (const [bucket, id] of buckets) {
      expect(horseTakesAddOn(id, 'event')).toBe(bucket < 740);
    }
    expect([...buckets.values()].filter((id) => horseTakesAddOn(id, 'event'))).toHaveLength(740);
  });

  it('does not reroll declined horses on repeated offers and varies across events', () => {
    const declined = ids.find((id) => !horseTakesAddOn(id, 'evt-1'))!;
    expect(declined).toBeDefined();
    for (let offer = 0; offer < 20; offer++) {
      expect(horseTakesAddOn(declined, 'evt-1')).toBe(false);
      expect(horseAddOnTiming(declined, 'evt-1', true)).toBe('declined');
    }
    const choices = Array.from({ length: 100 }, (_, i) => horseTakesAddOn('horse-a', `evt-${i}`));
    expect(new Set(choices).size).toBe(2);
  });

  it('is deterministic per horse and event', () => {
    expect(horseAddsOnImmediately('a', 'e1')).toBe(horseAddsOnImmediately('a', 'e1'));
    // and independent across events, so one horse is not always the early one
    const perEvent = Array.from({ length: 40 }, (_, i) => horseAddsOnImmediately('a', `e${i}`));
    expect(new Set(perEvent).size).toBe(2);
  });
});

describe('horses rebuy 0 to 5 times', () => {
  it('never allows more than five, and does allow zero', () => {
    const allowances = Array.from({ length: 3000 }, (_, i) => horseRebuyAllowance(`h-${i}`, 'e'));
    expect(Math.min(...allowances)).toBe(0);
    expect(Math.max(...allowances)).toBe(HORSE_MAX_REBUYS);
    allowances.forEach((a) => {
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThanOrEqual(5);
    });
  });
  it('spreads across all six outcomes', () => {
    const seen = new Set(
      Array.from({ length: 3000 }, (_, i) => horseRebuyAllowance(`h-${i}`, 'e'))
    );
    expect(seen.size).toBe(6);
  });
  it('stops at the horse allowance', () => {
    const horseId = 'h-1';
    const allow = horseRebuyAllowance(horseId, 'e');
    const base = { horseId, eventId: 'e', nowMs: 0, startMs: 0, cfg: std, available: 100 };
    expect(horseMayRebuy({ ...base, rebuysTaken: allow })).toBe(false);
    if (allow > 0) expect(horseMayRebuy({ ...base, rebuysTaken: allow - 1 })).toBe(true);
  });
  it('refuses once the rebuy period has closed', () => {
    expect(
      horseMayRebuy({
        horseId: 'h-x',
        eventId: 'e',
        rebuysTaken: 0,
        nowMs: 61 * 60_000,
        startMs: 0,
        cfg: std,
        available: 100,
      })
    ).toBe(false);
  });
  it('never spends chips the wallet does not have - a free ENTRY is not a free rebuy', () => {
    expect(
      horseMayRebuy({
        horseId: 'h-y',
        eventId: 'e',
        rebuysTaken: 0,
        nowMs: 0,
        startMs: 0,
        cfg: feat,
        available: 1,
      })
    ).toBe(false);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   THE SCHEDULER: the slot decides the clock, and the clock is Chicago's
   ══════════════════════════════════════════════════════════════════════════ */

import {
  chicagoDayKey,
  chicagoParts,
  chicagoWallClockToUtcMs,
  freeBuySlotsDue,
  freeBuyTournamentRow,
  FREE_BUY_BOARD_NAMES,
  freeBuyBreakEvenEntrants,
  lateRegLevelsForMinutes,
  ladderMinutesThrough,
  FREE_BUY_PUBLISH_LEAD_MS,
  FREE_BUY_HOSTS,
  auditFreeBuyRow,
  auditFreeBuyBoard,
  FREE_BUY_HELD_HOSTS,
  FREE_BUY_KNOWN_HOSTS,
  type DueFreeBuy,
  type FreeBuyHost,
} from './FreeBuy.js';
import { BLIND_STRUCTURES } from './TournamentRecurringService.js';
import { DSS_CLUB_ID, MIDWAY_UNION_ID } from './StableHand.js';

const HOUR = 60 * 60 * 1000;

/**
 * Deep Stack Society: held out of FREE_BUY_HOSTS by the 2026-10-04 operator
 * hold, but still a real host of its already-published rows. Read from the
 * exported list rather than re-typed, so a drifted copy cannot pass these.
 */
const DSS_HOST: FreeBuyHost = FREE_BUY_HELD_HOSTS.find((h) => h.clubId === DSS_CLUB_ID)!;

/** Index 0 is the live union host, index 1 the standalone one. */
const ROW_HOSTS: FreeBuyHost[] = [...FREE_BUY_HOSTS, DSS_HOST];

describe('a Chicago hour is a Chicago hour in July and in January', () => {
  /**
   * THE REGRESSION THIS EXISTS FOR. The recurring board matches on
   * getUTCHours(), and a Free Buy board built the same way would hold the
   * 20:00 feature event at 01:00 UTC all year - which IS 20:00 Chicago in
   * summer and 19:00 Chicago in winter. Every assertion below is the same
   * wall-clock hour landing on two different UTC instants.
   */
  it('20:00 Chicago is 01:00 UTC the next day under CDT', () => {
    const ms = chicagoWallClockToUtcMs('2026-07-15', 20);
    expect(new Date(ms).toISOString()).toBe('2026-07-16T01:00:00.000Z');
  });

  it('20:00 Chicago is 02:00 UTC the next day under CST', () => {
    const ms = chicagoWallClockToUtcMs('2026-01-15', 20);
    expect(new Date(ms).toISOString()).toBe('2026-01-16T02:00:00.000Z');
  });

  it('08:00 Chicago moves by exactly one hour between the two', () => {
    const summer = chicagoWallClockToUtcMs('2026-07-15', 8);
    const winter = chicagoWallClockToUtcMs('2026-01-15', 8);
    expect(new Date(summer).toISOString()).toBe('2026-07-15T13:00:00.000Z');
    expect(new Date(winter).toISOString()).toBe('2026-01-15T14:00:00.000Z');
  });

  it('every slot hour round-trips: the instant it returns reads back as that hour', () => {
    for (const dayKey of ['2026-01-15', '2026-03-08', '2026-07-15', '2026-11-01', '2026-12-31']) {
      for (const slot of FREE_BUY_SLOTS) {
        const ms = chicagoWallClockToUtcMs(dayKey, slot.chicagoHour, FREE_BUY_SLOT_MINUTE);
        const p = chicagoParts(ms);
        expect(p.hour, `${dayKey} ${freeBuySlotTime(slot)}`).toBe(slot.chicagoHour);
        expect(p.minute).toBe(FREE_BUY_SLOT_MINUTE);
        expect(chicagoDayKey(ms)).toBe(dayKey);
      }
    }
  });

  it('the two DST transition days still resolve every slot', () => {
    // 2026-03-08 springs forward (02:00 does not exist) and 2026-11-01 falls
    // back (01:00 happens twice). No Free Buy hour is either one, which is why
    // the two-pass conversion needs no special case.
    for (const slot of FREE_BUY_SLOTS) {
      expect([2]).not.toContain(slot.chicagoHour);
      expect([1]).not.toContain(slot.chicagoHour);
    }
  });
});

describe('the publication lead is shorter than the cadence', () => {
  it('never puts two Free Buys for one host on the board at once', () => {
    const cadenceMs = 4 * HOUR;
    expect(FREE_BUY_PUBLISH_LEAD_MS).toBeLessThan(cadenceMs);
    // and long enough to clear fn_freeroll_fill_targets' 90-minute window
    expect(FREE_BUY_PUBLISH_LEAD_MS).toBeGreaterThan(90 * 60 * 1000);
  });

  it('at most one slot is ever due at a time, sampled across a whole day', () => {
    const day = Date.UTC(2026, 6, 15, 0, 0, 0);
    for (let m = 0; m < 24 * 60; m += 5) {
      const due = freeBuySlotsDue(day + m * 60_000);
      expect(due.length, `at +${m}m`).toBeLessThanOrEqual(1);
    }
  });
});

describe('freeBuySlotsDue', () => {
  it('publishes a slot exactly at the lead and not a minute before', () => {
    const start = chicagoWallClockToUtcMs('2026-07-15', 20, 30);
    expect(freeBuySlotsDue(start - FREE_BUY_PUBLISH_LEAD_MS)).toHaveLength(1);
    expect(freeBuySlotsDue(start - FREE_BUY_PUBLISH_LEAD_MS - 60_000)).toHaveLength(0);
  });

  it('never publishes a slot that has already started', () => {
    const start = chicagoWallClockToUtcMs('2026-07-15', 20, 30);
    const due = freeBuySlotsDue(start + 1);
    expect(due.map((d) => d.startMs)).not.toContain(start);
  });

  it('sees TOMORROW 12:30 AM from the evening before', () => {
    // 22:00 Chicago on the 15th: the 00:30 slot belongs to the 16th and is
    // two and a half hours away. Reading only "today" would never find it.
    const due = freeBuySlotsDue(chicagoWallClockToUtcMs('2026-07-15', 22));
    expect(due).toHaveLength(1);
    expect(due[0].dayKey).toBe('2026-07-16');
    expect(due[0].slot.chicagoHour).toBe(0);
  });

  it('carries the tier the slot was declared with', () => {
    const start = chicagoWallClockToUtcMs('2026-07-15', 20, 30);
    const due = freeBuySlotsDue(start - HOUR);
    expect(due[0].slot.tier).toBe('feature');
    const std8 = freeBuySlotsDue(chicagoWallClockToUtcMs('2026-07-15', 8, 30) - HOUR);
    expect(std8[0].slot.tier).toBe('standard');
  });

  it('produces exactly five starts per host per Chicago day', () => {
    // Start sampling at 21:00 the evening BEFORE, so a slot that comes due
    // ahead of itself on the previous date is still seen.
    const dayStart = chicagoWallClockToUtcMs('2026-07-14', 21);
    const seen = new Set<number>();
    for (let m = 0; m < 27 * 60; m += 5) {
      for (const d of freeBuySlotsDue(dayStart + m * 60_000)) {
        if (chicagoDayKey(d.startMs) === '2026-07-15') seen.add(d.startMs);
      }
    }
    expect(seen.size).toBe(5);
    expect([...seen].map((ms) => chicagoParts(ms).hour).sort((a, b) => a - b)).toEqual([
      0, 8, 12, 16, 20,
    ]);
  });
});

describe('the late-reg level count is derived from the ladder, not guessed', () => {
  it('sums level durations', () => {
    const ladder = [{ durationMinutes: 4 }, { durationMinutes: 4 }, { durationMinutes: 2 }];
    expect(ladderMinutesThrough(ladder, 0)).toBe(0);
    expect(ladderMinutesThrough(ladder, 2)).toBe(8);
    expect(ladderMinutesThrough(ladder, 99)).toBe(10);
  });

  it('picks the level nearest the target rather than truncating', () => {
    const ladder = Array.from({ length: 20 }, () => ({ durationMinutes: 4 }));
    expect(lateRegLevelsForMinutes(ladder, 60)).toBe(15);
    // 62 minutes is nearer level 16 (64)? No - 60 is 2 away and 64 is 2 away,
    // and a tie goes to the SHORTER side, so late registration never runs
    // longer than the hour that was advertised.
    expect(lateRegLevelsForMinutes(ladder, 62)).toBe(15);
    expect(lateRegLevelsForMinutes(ladder, 58)).toBe(14);
    expect(lateRegLevelsForMinutes(ladder, 59)).toBe(15);
  });

  it('never returns 0 - a zero late-reg level count closes registration instantly', () => {
    expect(lateRegLevelsForMinutes([], 60)).toBe(1);
    expect(lateRegLevelsForMinutes([{ durationMinutes: 4 }], 0)).toBe(1);
  });

  it('the real Free Buy ladder lands within one level of the hour Dan asked for', () => {
    const levels = lateRegLevelsForMinutes(BLIND_STRUCTURES.FREE_BUY, 60);
    const minutes = ladderMinutesThrough(BLIND_STRUCTURES.FREE_BUY, levels);
    expect(Math.abs(minutes - 60)).toBeLessThanOrEqual(6);
  });
});

describe('the hosts', () => {
  it('is Midway Union alone while Deep Stack Society is held', () => {
    // OPERATOR HOLD 2026-10-04: Deep Stack Society is commented out of
    // FREE_BUY_HOSTS so checkAndCreateFreeBuys stops publishing its board.
    // This asserts the hold rather than the old two-host shape; lifting the
    // hold means asserting [MIDWAY_UNION_ID, DSS_CLUB_ID] here again.
    expect(FREE_BUY_HOSTS.map((h) => h.hostId)).toEqual([MIDWAY_UNION_ID]);
  });

  it('does not publish a Deep Stack Society board while held', () => {
    expect(FREE_BUY_HOSTS.some((h) => h.clubId === DSS_CLUB_ID)).toBe(false);
  });

  it('still KNOWS Deep Stack Society, so its published rows stay legitimate', () => {
    // The hold changes who a board is published for, not whose rows are real.
    expect(FREE_BUY_HELD_HOSTS.map((h) => h.clubId)).toEqual([DSS_CLUB_ID]);
    expect(FREE_BUY_KNOWN_HOSTS.map((h) => h.clubId)).toEqual([MIDWAY_UNION_ID, DSS_CLUB_ID]);
  });

  it('a held host keeps its standalone shape - the overlay bank depends on it', () => {
    // fn_ca_fund_overlay_on_lock reads union_id and nothing else, so a held
    // entry with the wrong shape would misroute the overlay on restore.
    expect(DSS_HOST.unionId).toBeNull();
    expect(DSS_HOST.clubId).toBe(DSS_CLUB_ID);
  });

  it('MIDWAY UNION STAMPS union_id - the overlay bank depends on it', () => {
    // fn_ca_fund_overlay_on_lock funds from union_wallets when union_id is set
    // and from clubs.chip_treasury when it is not. Midway Union's treasury
    // held 0.66 chips on 2026-09-04 against a union bank of 66,596.
    const union = FREE_BUY_HOSTS.find((h) => h.hostId === MIDWAY_UNION_ID)!;
    expect(union.unionId).toBe(MIDWAY_UNION_ID);
    expect(union.clubId).toBe(MIDWAY_UNION_ID);
  });

  it('a standalone club host carries no union', () => {
    // Held out of FREE_BUY_HOSTS, but freeBuyTournamentRow's standalone branch
    // is still live for every other club, so its shape stays under test.
    expect(DSS_HOST.unionId).toBeNull();
    expect(DSS_HOST.clubId).toBe(DSS_CLUB_ID);
  });
});

describe('the row a Free Buy is created as', () => {
  const dueFor = (dayKey: string, hour: number): DueFreeBuy => {
    const slot = FREE_BUY_SLOTS.find((s) => s.chicagoHour === hour)!;
    return { slot, dayKey, startMs: chicagoWallClockToUtcMs(dayKey, hour, FREE_BUY_SLOT_MINUTE) };
  };
  const rowFor = (hostIdx: number, hour: number) =>
    freeBuyTournamentRow({
      host: ROW_HOSTS[hostIdx],
      due: dueFor('2026-07-15', hour),
      blindStructure: BLIND_STRUCTURES.FREE_BUY as unknown[],
      payoutStructure: [{ place: 1, percentage: 100 }],
      tableSize: 9,
      lateRegLevels: 15,
    });

  it('new Free Buy events explicitly pay the top fifteen percent', () => {
    expect(rowFor(0, 8)).toMatchObject({ payout_percent: 15, payout_depth_percent: 15 });
  });

  it('is published under a board name, which is how the watch finds its rows', () => {
    /* 2026-10-05. Every freeroll carries free_buy, so the hourly watch and
       freebuy:verify select the board by FREE_BUY_BOARD_NAMES. A row published
       under any other name would be a board event the watch never reads. */
    for (const slot of FREE_BUY_SLOTS) {
      const name = String(rowFor(0, slot.chicagoHour).name);
      expect(FREE_BUY_BOARD_NAMES).toContain(name);
    }
    expect(new Set(FREE_BUY_BOARD_NAMES).size).toBe(FREE_BUY_SLOTS.length);
    // A correct non-board freeroll is not one of them.
    expect(FREE_BUY_BOARD_NAMES).not.toContain('$100 Freeroll • 6:00 AM');
  });

  it('the first entry is free on both halves - the CHECK constraint refuses anything else', () => {
    const row = rowFor(0, 8);
    expect(row.buy_in_amount).toBe(0);
    expect(row.buy_in_fee).toBe(0);
    expect(row.free_buy).toBe(true);
  });

  it('carries the standard tier price and the 10,000 chip add-on', () => {
    const row = rowFor(0, 8);
    expect(row.guaranteed_prize).toBe(250);
    expect(row.starting_chips).toBe(3000);
    expect(row.rebuy_cost).toBe(1);
    expect(row.addon_cost).toBe(1);
    expect(row.addon_chips).toBe(10000);
  });

  it('carries the feature tier guarantee at 20:00, at the same 1 chip rebuy and add-on (Dan 2026-10-16)', () => {
    const row = rowFor(0, 20);
    expect(row.guaranteed_prize).toBe(500);
    expect(row.rebuy_cost).toBe(1);
    expect(row.addon_cost).toBe(1);
    expect(row.addon_chips).toBe(10000);
  });

  it('sets free_buy AND a positive rebuy_cost together, or the trigger reprices it to 1.00', () => {
    // Every Midway freeroll rebuy and add-on is 1 chip (Dan 2026-10-16), and
    // fn_freerolls_are_free_buy forces exactly that; the row states it too.
    const row = rowFor(0, 20);
    expect(row.free_buy).toBe(true);
    expect(Number(row.rebuy_cost)).toBeGreaterThan(0);
  });

  it('opens the add-on at sit-down', () => {
    const row = rowFor(0, 8);
    expect(row.add_on_available).toBe(true);
    expect(row.addon_from_start).toBe(true);
  });

  it('rebuys close exactly when late registration does', () => {
    const row = rowFor(0, 8);
    expect(row.is_rebuy).toBe(true);
    expect(row.rebuy_levels).toBe(row.late_reg_levels);
    expect(row.late_reg_mins).toBe(60);
  });

  it('max_rebuys is NULL, never 0', () => {
    // process_tournament_rebuy reads a NOT NULL 0 as "Rebuy limit reached
    // (0 of 0)" and denies every rebuy on the event.
    expect(rowFor(0, 8).max_rebuys).toBeNull();
  });

  it('a Union Free Buy stamps union_id and a Deep Stack one does not', () => {
    expect(rowFor(0, 8).union_id).toBe(MIDWAY_UNION_ID);
    expect(rowFor(0, 8).club_id).toBe(MIDWAY_UNION_ID);
    expect(rowFor(1, 8).union_id).toBeNull();
    expect(rowFor(1, 8).club_id).toBe(DSS_CLUB_ID);
  });

  it('starts at the slot instant, to the second', () => {
    expect(rowFor(0, 20).start_time).toBe('2026-07-16T01:30:00.000Z');
  });

  it('is a pre-start MTT so the occurrence index actually covers it', () => {
    const row = rowFor(0, 8);
    expect(row.tournament_type).toBe('MTT');
    expect(row.status).toBe('REGISTERING');
    expect(row.variant).toBe('freezeout');
  });

  it('the two hosts differ only by owner, so one name per slot is safe', () => {
    // uq_scheduled_tournament_one_live_per_occurrence is unique on
    // (club_id, tournament_type, name, start_time). Same name, different
    // club_id: both hosts get their own event.
    expect(rowFor(0, 8).name).toBe(rowFor(1, 8).name);
    expect(rowFor(0, 8).club_id).not.toBe(rowFor(1, 8).club_id);
  });

  it('carries no bounty', () => {
    const row = rowFor(0, 8);
    expect(row.is_bounty).toBe(false);
    expect(row.is_pko).toBe(false);
    expect(row.is_mystery_bounty).toBe(false);
  });
});

describe('the field is sized to cover its own guarantee', () => {
  it('a full standard field breaks even on add-ons and one rebuy each', () => {
    expect(freeBuyBreakEvenEntrants(std)).toBeLessThanOrEqual(std.maxPlayers);
  });

  it('a full feature field does too', () => {
    expect(freeBuyBreakEvenEntrants(feat)).toBeLessThanOrEqual(feat.maxPlayers);
  });

  it('the reduced guarantees can be covered by a full field taking one add-on', () => {
    expect(freeBuyBreakEvenEntrants(std, 0)).toBe(250);
    expect(freeBuyBreakEvenEntrants(feat, 0)).toBe(500);
    expect(freeBuyBreakEvenEntrants(std, 0)).toBeLessThanOrEqual(std.maxPlayers);
    expect(freeBuyBreakEvenEntrants(feat, 0)).toBeLessThanOrEqual(feat.maxPlayers);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   THE LADDER HAS TO SURVIVE THE HOUR DAN ASKED FOR

   Three of his numbers decide this together: 3,000 to start, a 10,000 add-on,
   and one hour of late registration. Measured against the house TURBO before
   this was written: 24 levels, 57 MINUTES end to end, and a big blind of
   1,500,000 at the one-hour mark - zero big blinds against a 13,000 stack, and
   an add-on worth nothing by the time anyone could take it.
   ══════════════════════════════════════════════════════════════════════════ */
describe('the Free Buy ladder', () => {
  const L = BLIND_STRUCTURES.FREE_BUY as Array<{ bigBlind: number; durationMinutes: number }>;
  const START = 3000;
  const EFFECTIVE = START + FREE_BUY_TIERS.standard.addOnChips;

  it('starts deep: 3,000 chips is a real stack at level one', () => {
    expect(START / L[0].bigBlind).toBeGreaterThanOrEqual(100);
  });

  it('is still poker at the hour, so the add-on is worth taking', () => {
    const lv = lateRegLevelsForMinutes(L, 60);
    const bb = L[lv - 1].bigBlind;
    const depth = EFFECTIVE / bb;
    expect(depth).toBeGreaterThanOrEqual(20);
  });

  it('OUTLASTS late registration - the break is not the end of the structure', () => {
    const lv = lateRegLevelsForMinutes(L, 60);
    expect(L.length - lv).toBeGreaterThanOrEqual(8);
    expect(ladderMinutesThrough(L, L.length)).toBeGreaterThan(120);
  });

  it('and the house TURBO could not have done any of that', () => {
    // Kept as a comparison rather than deleted: this is the number that
    // decided the structure, and without it the next agent reads "STANDARD"
    // as somebody's taste.
    const T = BLIND_STRUCTURES.TURBO as Array<{ bigBlind: number; durationMinutes: number }>;
    // Owner October 21: even TURBO retains five minutes at every level.
    expect(T.every((level) => level.durationMinutes >= 5)).toBe(true);
    expect(ladderMinutesThrough(T, T.length)).toBe(120);
    const lv = lateRegLevelsForMinutes(T, 60);
    expect(EFFECTIVE / T[lv - 1].bigBlind).toBeLessThan(20);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   THE AUDIT. The tests above pin the row the code BUILDS. This is the rule
   set that reads the row the DATABASE KEPT - five triggers rewrite a
   tournament on the way in, and one of them exists to force every 0-buy-in
   MTT's rebuy and add-on to 1.00.
   ══════════════════════════════════════════════════════════════════════════ */
describe('auditFreeBuyRow', () => {
  const startOf = (hour: number) =>
    new Date(chicagoWallClockToUtcMs('2026-09-05', hour, FREE_BUY_SLOT_MINUTE)).toISOString();
  const good = (over: Record<string, unknown> = {}) => ({
    name: 'Morning Free Buy (NLH)',
    club_id: FREE_BUY_HOSTS[0].clubId,
    union_id: FREE_BUY_HOSTS[0].unionId,
    start_time: startOf(8),
    guaranteed_prize: 250,
    buy_in_amount: 0,
    buy_in_fee: 0,
    starting_chips: 3000,
    rebuy_cost: 1,
    addon_cost: 1,
    addon_chips: 10000,
    addon_from_start: true,
    add_on_available: true,
    is_rebuy: true,
    max_rebuys: null,
    late_reg_mins: 60,
    late_reg_levels: 11,
    rebuy_levels: 11,
    ...over,
  });

  it('says nothing about a correct row', () => {
    expect(auditFreeBuyRow(good())).toEqual([]);
  });

  it('passes the Prime Time Free Buy at a 1 chip rebuy and add-on (Dan 2026-10-16)', () => {
    const feature = good({
      name: 'Prime Time Free Buy (NLH)',
      start_time: startOf(20),
      guaranteed_prize: 500,
      rebuy_cost: 1,
      addon_cost: 1,
    });
    expect(auditFreeBuyRow(feature)).toEqual([]);
  });

  it('catches a Free Buy that still charges 2 for a rebuy or add-on', () => {
    // The audit reads the DATABASE, not the code: a row the trigger did not
    // reprice is exactly what it exists to find.
    const feature = good({
      name: 'Prime Time Free Buy (NLH)',
      start_time: startOf(20),
      guaranteed_prize: 500,
      rebuy_cost: 2,
      addon_cost: 2,
    });
    const p = auditFreeBuyRow(feature);
    expect(p.some((x) => x.includes('rebuy 2'))).toBe(true);
    expect(p.some((x) => x.includes('add-on 2'))).toBe(true);
  });

  it('reads an event that started before the board moved against the board it ran on', () => {
    // The last four of the old board ran at the top of the hour on 2026-10-16
    // and 10-17, and the audit reads 24 hours back.
    const at = (hour: number, day: string, minute: number) =>
      new Date(chicagoWallClockToUtcMs(day, hour, minute)).toISOString();
    for (const [hour, day, prize] of [
      [12, '2026-10-16', 250],
      [16, '2026-10-16', 250],
      [20, '2026-10-16', 500],
      [0, '2026-10-17', 250],
    ] as const) {
      const name = FREE_BUY_SLOTS.find((s) => s.chicagoHour === hour)!.label + ' (NLH)';
      expect(
        auditFreeBuyRow(good({ name, start_time: at(hour, day, 0), guaranteed_prize: prize }))
      ).toEqual([]);
    }
    // The first slot of the half-hour board onward must start on the half hour.
    expect(Date.parse(at(8, '2026-10-17', 0))).toBe(FREE_BUY_HALF_HOUR_SLOTS_FROM_MS);
    expect(
      auditFreeBuyRow(good({ start_time: at(8, '2026-10-17', 0), guaranteed_prize: 250 })).some(
        (x) => x.includes('not on the half hour')
      )
    ).toBe(true);
    // Before the move, only the old minute is excused; any other minute is wrong.
    expect(
      auditFreeBuyRow(good({ start_time: at(12, '2026-10-16', 15), guaranteed_prize: 250 })).some(
        (x) => x.includes('not on the half hour')
      )
    ).toBe(true);
  });

  it('accepts the guarantee a date before the doubling was published with, but never its old hour', () => {
    // 2026-10-17..19 were published at 250 / 500 and moved onto the half hour;
    // their guarantees are frozen by the settlement contract.
    const at = (hour: number, day: string, minute: number) =>
      new Date(chicagoWallClockToUtcMs(day, hour, minute)).toISOString();
    expect(
      auditFreeBuyRow(good({ start_time: at(8, '2026-10-17', 30), guaranteed_prize: 250 }))
    ).toEqual([]);
    expect(
      auditFreeBuyRow(
        good({
          name: 'Prime Time Free Buy (NLH)',
          start_time: at(20, '2026-10-19', 30),
          guaranteed_prize: 500,
        })
      )
    ).toEqual([]);
    // The previous guarantee never excuses the old hour.
    expect(
      auditFreeBuyRow(good({ start_time: at(8, '2026-10-17', 0), guaranteed_prize: 250 })).some(
        (x) => x.includes('not on the half hour')
      )
    ).toBe(true);
    // A guarantee that is neither tier is still wrong.
    expect(
      auditFreeBuyRow(good({ start_time: at(8, '2026-10-17', 30), guaranteed_prize: 100 })).some(
        (x) => x.includes('guarantee 100')
      )
    ).toBe(true);
    // The current morning guarantee is 250; an unregistered 500 is wrong.
    expect(
      auditFreeBuyRow(good({ start_time: at(8, '2026-10-26', 30), guaranteed_prize: 500 })).some(
        (x) => x.includes('guarantee 500')
      )
    ).toBe(true);
  });

  it('catches a paid first entry', () => {
    expect(auditFreeBuyRow(good({ buy_in_amount: 5 }))).toContain('the first entry is not free');
  });

  it('catches a max_rebuys that would deny every rebuy', () => {
    // process_tournament_rebuy reads a NOT NULL 0 as "Rebuy limit reached".
    expect(
      auditFreeBuyRow(good({ max_rebuys: 0 })).some((x) => x.includes('denies every rebuy'))
    ).toBe(true);
  });

  it('catches an add-on that does not open at sit-down', () => {
    expect(auditFreeBuyRow(good({ addon_from_start: false }))).toContain(
      'the add-on does not open at sit-down'
    );
  });

  it('CATCHES A MISSING union_id, which chooses the overlay bank', () => {
    expect(auditFreeBuyRow(good({ union_id: null })).some((x) => x.includes('overlay bank'))).toBe(
      true
    );
  });

  it('catches an event that is not on a slot hour', () => {
    expect(
      auditFreeBuyRow(good({ start_time: startOf(9) })).some((x) =>
        x.includes('not one of the board slots')
      )
    ).toBe(true);
  });

  it('catches rebuys and late registration closing at different times', () => {
    expect(
      auditFreeBuyRow(good({ rebuy_levels: 4 })).some((x) => x.includes('do not close together'))
    ).toBe(true);
  });
});

describe('auditFreeBuyBoard', () => {
  const now = chicagoWallClockToUtcMs('2026-09-05', 13); // 13:00 Chicago
  const row = (hour: number, host = FREE_BUY_HOSTS[0], over: Record<string, unknown> = {}) => ({
    name: 'x',
    club_id: host.clubId,
    union_id: host.unionId,
    start_time: new Date(
      chicagoWallClockToUtcMs('2026-09-05', hour, FREE_BUY_SLOT_MINUTE)
    ).toISOString(),
    guaranteed_prize: freeBuyConfigForSlot(slotForChicagoHour(hour)!).guarantee,
    buy_in_amount: 0,
    buy_in_fee: 0,
    starting_chips: 3000,
    rebuy_cost: FREE_BUY_TIERS[slotForChicagoHour(hour)!.tier].rebuyCost,
    addon_cost: FREE_BUY_TIERS[slotForChicagoHour(hour)!.tier].addOnCost,
    addon_chips: 10000,
    addon_from_start: true,
    add_on_available: true,
    is_rebuy: true,
    max_rebuys: null,
    late_reg_mins: 60,
    late_reg_levels: 11,
    rebuy_levels: 11,
    ...over,
  });

  it('is happy with the slots that have actually come round', () => {
    // At 13:00 only the 08:00 and 12:00 slots have passed.
    const rows = FREE_BUY_HOSTS.flatMap((h) => [row(12, h), row(8, h)]);
    expect(auditFreeBuyBoard(rows, now).problems).toEqual([]);
  });

  it('DOES NOT cry wolf about a slot whose hour has not arrived', () => {
    // A board read at 13:00 has not had a chance to publish the 20:00 event.
    const rows = FREE_BUY_HOSTS.flatMap((h) => [row(12, h), row(8, h)]);
    const p = auditFreeBuyBoard(rows, now).problems;
    expect(p.some((x) => x.includes('Prime Time'))).toBe(false);
  });

  it("DOES NOT call a HELD host's published row a wrong board", () => {
    /* THE REGRESSION THIS EXISTS FOR (2026-10-05). Taking Deep Stack Society
       out of FREE_BUY_HOSTS for the operator hold left its 32 already-published
       rows resolving against a list that no longer contained them, so every one
       reported `club <id> is not a Free Buy host` and auditFreeBuyBoardOnce
       raised a warning financial_alerts row claiming the board was wrong. A
       deliberate hold is not a misconfigured event. */
    const held = row(20, DSS_HOST);
    const p = auditFreeBuyBoard([held], now).problems;
    expect(p.some((x) => x.includes('is not a Free Buy host'))).toBe(false);
  });

  it('still catches a row under a club that is no host at all', () => {
    // The check the test above must not have weakened.
    const stranger = row(20, {
      hostId: '00000000-0000-0000-0000-0000000000ff',
      clubId: '00000000-0000-0000-0000-0000000000ff',
      unionId: null,
      label: 'Not A Host',
    });
    const p = auditFreeBuyBoard([stranger], now).problems;
    expect(p.some((x) => x.includes('is not a Free Buy host'))).toBe(true);
  });

  it('notices a slot that came and went with nothing published', () => {
    const rows = [row(8), row(12)]; // Deep Stack published nothing
    // Passed explicitly: the audit only expects a board from a host it is
    // given, and the hold removed Deep Stack from the default list.
    const p = auditFreeBuyBoard(rows, now, ROW_HOSTS).problems;
    expect(p.some((x) => x.includes('Deep Stack Society published no'))).toBe(true);
  });

  it('notices two events sharing one host, slot and day', () => {
    const rows = FREE_BUY_HOSTS.flatMap((h) => [row(12, h), row(8, h), row(8, h)]);
    const p = auditFreeBuyBoard(rows, now).problems;
    expect(p.some((x) => x.includes('share one host, slot and Chicago day'))).toBe(true);
  });

  it('reports the count it actually checked', () => {
    expect(auditFreeBuyBoard([row(8)], now).checked).toBe(1);
  });
});
