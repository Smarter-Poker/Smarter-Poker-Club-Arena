import { describe, expect, it } from 'vitest';
import {
  mttLevelWindowMs,
  mttPlannedField,
  mttPrestartPlan,
  mttPrizeShare,
} from './mttHorseArrivalPlan.js';
import { mttPrestartHorseTarget, MTT_PRESTART_TICK_MS } from './TournamentRecurringService.js';
import { lateRegArrivalsFor } from './HorseOverlayGuard.js';

const MIN = 60_000;
function beforeStart(guarantee: number, prize: number, maxPlayers: number | null = null) {
  let current = 0;
  for (let remaining = 10 * MIN; remaining > 0; remaining -= MTT_PRESTART_TICK_MS) {
    const target = mttPrestartHorseTarget({
      msUntilStart: remaining,
      maxPlayers,
      format_contract: 'mtt-v2',
      variant: 'freezeout',
      currentPlayers: current,
      guaranteedPrize: guarantee,
      buyInPrizeShare: prize,
      prizePool: guarantee,
    });
    current = Math.max(current, target);
  }
  return current;
}

describe('half before start and the other half throughout late registration', () => {
  it.each([
    [5000, 36, 70],
    [1000, 6.5, 77],
    [50000, 90, 278],
    [0, 0, 24],
  ])('delivers half of %s at %s per entry inside ten minutes', (guarantee, share, expected) => {
    expect(beforeStart(guarantee, share)).toBe(expected);
  });
  it('splits the actual capped field before start instead of filling nearly every seat', () => {
    expect(mttPrestartPlan(139, 40)).toBe(20);
    expect(mttPrestartPlan(48, 9)).toBe(5);
    expect(mttPrestartPlan(48, 1)).toBe(0);
    expect(beforeStart(5000, 36, 40)).toBe(20);
  });
  it.each([20, 25])(
    'paces only remaining capped seats when %s entered before the start',
    (atStart) => {
      let late = 0;
      const arrivalMinutes: number[] = [];
      for (let minute = 0; minute < 80; minute += 2) {
        const n = lateRegArrivalsFor({
          tournament_id: 'capped',
          startedAtMs: 0,
          nowMs: minute * MIN,
          lateRegMins: 80,
          lateRegLevels: 10,
          currentLevel: 0,
          plannedField: 139,
          maxPlayers: 40,
          entriesAtStart: atStart,
          lateEntries: late,
        });
        late += n;
        if (n) arrivalMinutes.push(minute);
        expect(atStart + late).toBeLessThanOrEqual(40);
      }
      expect(late).toBe(40 - atStart);
      expect(arrivalMinutes.some((minute) => minute > 60)).toBe(true);
    }
  );
  it('subtracts the bounty head, not just the fee', () => {
    expect(mttPrizeShare({ buy_in_amount: '13.50', bounty_amount: '7.00' })).toBe(6.5);
    expect(mttPlannedField(1000, 6.5)).toBe(154);
  });
  it('reads the real stored JSON ladder and seconds-shaped ladders', () => {
    expect(
      mttLevelWindowMs(
        JSON.stringify(Array.from({ length: 10 }, () => ({ durationMinutes: 8 }))),
        10
      )
    ).toBe(80 * MIN);
    expect(mttLevelWindowMs([{ duration: 60 }, { duration: 120 }], 2)).toBe(3 * MIN);
    expect(mttLevelWindowMs('bad', 2)).toBeUndefined();
    expect(mttLevelWindowMs([{ duration: 60 }], 2)).toBeUndefined();
  });
  it('trickles the remaining 77 entries across the entire 48-minute mystery window', () => {
    let late = 0;
    const arrivals: number[] = [];
    for (let minute = 0; minute < 48; minute += 2) {
      const n = lateRegArrivalsFor({
        tournament_id: 'mystery',
        startedAtMs: 0,
        nowMs: minute * MIN,
        lateRegMins: 48,
        lateRegLevels: 6,
        currentLevel: 0,
        levelWindowMs: 48 * MIN,
        plannedField: 154,
        entriesAtStart: 77,
        lateEntries: late,
      });
      expect(n).toBeLessThanOrEqual(5);
      late += n;
      if (n) arrivals.push(minute);
    }
    expect(late).toBeGreaterThanOrEqual(73);
    expect(late).toBeLessThanOrEqual(77);
    expect(arrivals.some((minute) => minute > 40)).toBe(true);
  });
  it('continues the level-only freezeout even when current_level remains zero', () => {
    expect(
      lateRegArrivalsFor({
        tournament_id: 'freezeout',
        startedAtMs: 0,
        nowMs: 20 * MIN,
        lateRegMins: 0,
        lateRegLevels: 10,
        currentLevel: 0,
        levelWindowMs: 80 * MIN,
        plannedField: 139,
        entriesAtStart: 70,
        lateEntries: 0,
      })
    ).toBeGreaterThan(0);
  });
  it('keeps bounded arrivals after pauses while the actual DB door remains open', () => {
    const paused = {
      tournament_id: 'paused-mystery',
      startedAtMs: 0,
      nowMs: 60 * MIN,
      lateRegMins: 0,
      lateRegLevels: 6,
      currentLevel: 5,
      levelWindowMs: 48 * MIN,
      plannedField: 154,
      entriesAtStart: 77,
      lateEntries: 1,
    };
    expect(lateRegArrivalsFor({ ...paused, registrationOpen: true })).toBe(5);
    expect(lateRegArrivalsFor({ ...paused, registrationOpen: false })).toBe(0);
    expect(lateRegArrivalsFor(paused)).toBe(0);
    expect(lateRegArrivalsFor({ ...paused, registrationOpen: true, lateEntries: 77 })).toBe(0);
  });
  it('never opens purchases early or after late registration closes', () => {
    expect(
      mttPrestartHorseTarget({
        msUntilStart: 11 * MIN,
        maxPlayers: null,
        format_contract: 'mtt-v2',
        variant: 'freezeout',
        guaranteedPrize: 5000,
        buyInPrizeShare: 36,
      })
    ).toBe(0);
    expect(
      lateRegArrivalsFor({
        tournament_id: 'closed',
        startedAtMs: 0,
        nowMs: 48 * MIN,
        lateRegMins: 48,
        lateRegLevels: 0,
        currentLevel: 0,
        entriesAtStart: 77,
        lateEntries: 0,
      })
    ).toBe(0);
  });
});
