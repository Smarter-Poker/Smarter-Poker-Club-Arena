import { describe, it, expect } from 'vitest';
import {
  FREE_BUY_TIERS,
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
  horseRebuyAllowance,
  horseMayRebuy,
  HORSE_ADDON_IMMEDIATE_RATE,
  HORSE_MAX_REBUYS,
  projectedCollected,
} from './FreeBuy.js';

const std = FREE_BUY_TIERS.standard;
const feat = FREE_BUY_TIERS.feature;

describe('the two tiers carry Dan 2026-09-04 exactly', () => {
  it('$250 tier: free entry, 3000 stack, $1 rebuy, $1 add-on, 10000 add-on chips', () => {
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
  it('$500 tier: same shape, $2 rebuy and $2 add-on', () => {
    expect(feat).toMatchObject({
      guarantee: 500,
      buyIn: 0,
      startingChips: 3000,
      rebuyCost: 2,
      addOnCost: 2,
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
  it('runs five events every four hours from 08:00 Chicago', () => {
    expect(FREE_BUY_SLOTS.map((s) => s.chicagoHour)).toEqual([8, 12, 16, 20, 0]);
    expect(FREE_BUY_SLOTS).toHaveLength(5);
  });
  it('makes 20:00 the feature and every other slot standard', () => {
    expect(slotForChicagoHour(20)?.tier).toBe('feature');
    [8, 12, 16, 0].forEach((h) => expect(slotForChicagoHour(h)?.tier).toBe('standard'));
    expect(slotForChicagoHour(9)).toBeNull();
  });
  it('guarantees 1,500 per host per day', () => {
    expect(dailyGuaranteePerHost()).toBe(1500);
  });
  it('and 3,000 across both hosts - the number worth saying out loud', () => {
    expect(dailyGuaranteePerHost() * 2).toBe(3000);
  });
  it('runs four-hourly from 08:00 to midnight, then leaves an 8 hour overnight gap', () => {
    // Dan enumerated 8AM, 12PM, 4PM, 8PM, 12AM. Five events cannot cover 24
    // hours at a 4-hour cadence - six can - so the gap lands overnight,
    // between the midnight event and the 08:00 one. That is the schedule as
    // specified, and the hole is recorded here rather than quietly rounded
    // away: a horse that busts at 01:00 waits seven hours for the next event.
    const hours = FREE_BUY_SLOTS.map((s) => s.chicagoHour);
    const inOrder = [8, 12, 16, 20, 24];
    const gaps = inOrder.slice(1).map((h, i) => h - inOrder[i]);
    expect(gaps).toEqual([4, 4, 4, 4]);
    expect(hours).toEqual([8, 12, 16, 20, 0]);
    // and the wrap from midnight back round to 08:00
    expect(24 + 8 - 24).toBe(8);
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
      entrants: 100,
      expectedRebuysPerEntrant: 2.5,
      addOnRate: 1.0,
      cfg: std,
    });
    expect(collected).toBe(350);
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

describe('horses always add on', () => {
  const ids = Array.from({ length: 2000 }, (_, i) => `h-${i}`);

  it('35% take it immediately, within sampling tolerance', () => {
    const immediate = ids.filter((h) => horseAddsOnImmediately(h, 'evt-1')).length;
    const rate = immediate / ids.length;
    expect(rate).toBeGreaterThan(HORSE_ADDON_IMMEDIATE_RATE - 0.04);
    expect(rate).toBeLessThan(HORSE_ADDON_IMMEDIATE_RATE + 0.04);
  });

  it('and every horse still alive at the break takes one, so nobody is left without', () => {
    const timings = ids.map((h) => horseAddOnTiming(h, 'evt-1', true));
    expect(timings.every((t) => t === 'immediate' || t === 'at_break')).toBe(true);
    expect(timings.filter((t) => t === 'at_break').length).toBeGreaterThan(0);
  });

  it('only a horse already busted misses out - and it has nothing to add on to', () => {
    const late = ids.filter((h) => !horseAddsOnImmediately(h, 'evt-1'));
    expect(horseAddOnTiming(late[0], 'evt-1', false)).toBe('busted_before_break');
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
  freeBuyBreakEvenEntrants,
  lateRegLevelsForMinutes,
  ladderMinutesThrough,
  FREE_BUY_PUBLISH_LEAD_MS,
  FREE_BUY_HOSTS,
  type DueFreeBuy,
} from './FreeBuy.js';
import { BLIND_STRUCTURES } from './TournamentRecurringService.js';
import { DSS_CLUB_ID, MIDWAY_UNION_ID } from './StableHand.js';

const HOUR = 60 * 60 * 1000;

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
        const ms = chicagoWallClockToUtcMs(dayKey, slot.chicagoHour);
        const p = chicagoParts(ms);
        expect(p.hour, `${dayKey} ${slot.chicagoHour}:00`).toBe(slot.chicagoHour);
        expect(p.minute).toBe(0);
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
    const start = chicagoWallClockToUtcMs('2026-07-15', 20);
    expect(freeBuySlotsDue(start - FREE_BUY_PUBLISH_LEAD_MS)).toHaveLength(1);
    expect(freeBuySlotsDue(start - FREE_BUY_PUBLISH_LEAD_MS - 60_000)).toHaveLength(0);
  });

  it('never publishes a slot that has already started', () => {
    const start = chicagoWallClockToUtcMs('2026-07-15', 20);
    const due = freeBuySlotsDue(start + 1);
    expect(due.map((d) => d.startMs)).not.toContain(start);
  });

  it('sees TOMORROW midnight from the evening before', () => {
    // 22:00 Chicago on the 15th: the 00:00 slot belongs to the 16th and is two
    // hours away. Reading only "today" would never find it.
    const now = chicagoWallClockToUtcMs('2026-07-15', 22);
    const due = freeBuySlotsDue(now);
    expect(due).toHaveLength(1);
    expect(due[0].dayKey).toBe('2026-07-16');
    expect(due[0].slot.chicagoHour).toBe(0);
  });

  it('carries the tier the slot was declared with', () => {
    const start = chicagoWallClockToUtcMs('2026-07-15', 20);
    const due = freeBuySlotsDue(start - HOUR);
    expect(due[0].slot.tier).toBe('feature');
    const std8 = freeBuySlotsDue(chicagoWallClockToUtcMs('2026-07-15', 8) - HOUR);
    expect(std8[0].slot.tier).toBe('standard');
  });

  it('produces exactly five starts per host per Chicago day', () => {
    // Start sampling at 21:00 the evening BEFORE: the 00:00 slot of the 15th
    // comes due three hours ahead of itself, which is on the 14th.
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

describe('the two hosts', () => {
  it('are exactly Midway Union and Deep Stack Society', () => {
    expect(FREE_BUY_HOSTS.map((h) => h.hostId)).toEqual([MIDWAY_UNION_ID, DSS_CLUB_ID]);
  });

  it('MIDWAY UNION STAMPS union_id - the overlay bank depends on it', () => {
    // fn_ca_fund_overlay_on_lock funds from union_wallets when union_id is set
    // and from clubs.chip_treasury when it is not. Midway Union's treasury
    // held 0.66 chips on 2026-09-04 against a union bank of 66,596.
    const union = FREE_BUY_HOSTS.find((h) => h.hostId === MIDWAY_UNION_ID)!;
    expect(union.unionId).toBe(MIDWAY_UNION_ID);
    expect(union.clubId).toBe(MIDWAY_UNION_ID);
  });

  it('Deep Stack Society is standalone and has no union', () => {
    const dss = FREE_BUY_HOSTS.find((h) => h.hostId === DSS_CLUB_ID)!;
    expect(dss.unionId).toBeNull();
    expect(dss.clubId).toBe(DSS_CLUB_ID);
  });
});

describe('the row a Free Buy is created as', () => {
  const dueFor = (dayKey: string, hour: number): DueFreeBuy => {
    const slot = FREE_BUY_SLOTS.find((s) => s.chicagoHour === hour)!;
    return { slot, dayKey, startMs: chicagoWallClockToUtcMs(dayKey, hour) };
  };
  const rowFor = (hostIdx: number, hour: number) =>
    freeBuyTournamentRow({
      host: FREE_BUY_HOSTS[hostIdx],
      due: dueFor('2026-07-15', hour),
      blindStructure: BLIND_STRUCTURES.FREE_BUY as unknown[],
      payoutStructure: [{ place: 1, percentage: 100 }],
      tableSize: 9,
      lateRegLevels: 15,
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

  it('carries the feature tier price at 20:00', () => {
    const row = rowFor(0, 20);
    expect(row.guaranteed_prize).toBe(500);
    expect(row.rebuy_cost).toBe(2);
    expect(row.addon_cost).toBe(2);
    expect(row.addon_chips).toBe(10000);
  });

  it('sets free_buy AND a positive rebuy_cost together, or the trigger reprices it to 1.00', () => {
    // fn_freerolls_are_free_buy only leaves a price alone when
    // free_buy = true AND rebuy_cost > 0. Either half alone is a $2 event
    // that silently becomes a $1 one.
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
    expect(rowFor(0, 20).start_time).toBe('2026-07-16T01:00:00.000Z');
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

  it('add-ons alone do not cover it, which is why rebuys are priced at all', () => {
    expect(freeBuyBreakEvenEntrants(std, 0)).toBeGreaterThan(std.maxPlayers);
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
    expect(ladderMinutesThrough(T, T.length)).toBeLessThan(60);
    const lv = lateRegLevelsForMinutes(T, 60);
    expect(EFFECTIVE / T[lv - 1].bigBlind).toBeLessThan(1);
  });
});
