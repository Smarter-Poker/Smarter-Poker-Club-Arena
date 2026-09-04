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
      blindStructure: 'TURBO',
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
      blindStructure: 'TURBO',
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
