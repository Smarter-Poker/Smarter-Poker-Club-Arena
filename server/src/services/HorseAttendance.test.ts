/**
 * ATTENDANCE (Dan 2026-09-03): "PRIME TIME 5PM-12AM HAS 45-60% OF THE MEMBERS
 * IN THE CLUB PLAYING, MORNING FROM LIKE 9AM-5PM SHOULD HAVE LIKE 20-25% AND
 * LATE NIGHT, FROM 12AM-9AM SHOULD SLOWLY TRICKLE DOWN... WE SHOULDN'T HAVE
 * MORE THAN 10% OF THE CLUB PLAYING BETWEEN 3AM-8AM."
 *
 * These pin the curve to his bands, the chronotype to a pool that can always
 * supply the curve, the trickle to a human pace, the yield clock to "not
 * right away", and the wiring in both managers.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  arrivalsBudget,
  attendanceFraction,
  attendanceTarget,
  bedtimeLeaveProbability,
  chicagoMinuteOfDay,
  chronotypeFor,
  departuresBudget,
  firstYieldDelayMs,
  isAwake,
  mayYieldNow,
  minutesPastBedtime,
  nextYieldGapMs,
  OWL_FRACTION,
  sleepPriority,
} from './HorseAttendance.js';

const H = (h: number, m = 0) => h * 60 + m;
const fleet = Array.from({ length: 600 }, (_, i) => `horse-${i}-${(i * 7919) % 10007}`);

describe('the curve sits inside the bands Dan named', () => {
  it('prime time 17:00-24:00 is 45-60%', () => {
    for (let m = H(17); m < H(24); m += 5) {
      for (const dow of [1, 5]) {
        const f = attendanceFraction(m, dow);
        expect(f, `at ${m} dow ${dow}`).toBeGreaterThanOrEqual(0.45);
        expect(f, `at ${m} dow ${dow}`).toBeLessThanOrEqual(0.6);
      }
    }
  });
  it('daytime 10:00-15:00 is 20-25%', () => {
    for (let m = H(10); m <= H(15); m += 5) {
      const f = attendanceFraction(m);
      expect(f).toBeGreaterThanOrEqual(0.2);
      expect(f).toBeLessThanOrEqual(0.25);
    }
  });
  it('dead zone 03:00-08:00 never exceeds 10%, even with the club wobble', () => {
    for (let m = H(3); m <= H(8); m += 5) {
      expect(attendanceFraction(m, 6)).toBeLessThanOrEqual(0.1);
    }
    // attendanceTarget adds up to +4% proportional wobble: 10% * 1.04 < 10.5%.
    const roster = 584;
    for (let hour = 3; hour <= 8; hour++) {
      // 2026-09-03 is CDT (UTC-5): 03:00 Chicago = 08:00Z.
      const now = Date.UTC(2026, 8, 3, hour + 5, 0, 0);
      for (const club of ['a41434bb', 'a0000000', '2a1132b9']) {
        expect(attendanceTarget(club, roster, now)).toBeLessThanOrEqual(Math.round(roster * 0.105));
      }
    }
  });
  it('is continuous - no step larger than 1% per minute anywhere in the day', () => {
    for (let m = 0; m < 1440; m++) {
      const d = Math.abs(attendanceFraction(m + 1) - attendanceFraction(m));
      expect(d, `at minute ${m}`).toBeLessThan(0.01);
    }
    expect(attendanceFraction(0)).toBeCloseTo(attendanceFraction(1440), 10);
  });
  it('winds down from midnight and picks back up after 08:00', () => {
    expect(attendanceFraction(H(0))).toBeGreaterThan(attendanceFraction(H(1)));
    expect(attendanceFraction(H(1))).toBeGreaterThan(attendanceFraction(H(2)));
    expect(attendanceFraction(H(2))).toBeGreaterThan(attendanceFraction(H(3)));
    expect(attendanceFraction(H(8))).toBeLessThan(attendanceFraction(H(9)));
    expect(attendanceFraction(H(9))).toBeLessThan(attendanceFraction(H(10)));
    expect(attendanceFraction(H(16))).toBeLessThan(attendanceFraction(H(17)));
  });
});

describe('the clock is Chicago', () => {
  it('reads 14:05 CDT for 19:05Z on 2026-09-03 and 13:05 CST for 19:05Z on 2026-12-03', () => {
    expect(chicagoMinuteOfDay(Date.UTC(2026, 8, 3, 19, 5))).toBe(H(14, 5));
    expect(chicagoMinuteOfDay(Date.UTC(2026, 11, 3, 19, 5))).toBe(H(13, 5));
  });
});

describe('the chronotype', () => {
  it('is stable and about OWL_FRACTION are owls', () => {
    const owls = fleet.filter((id) => chronotypeFor(id).owl).length / fleet.length;
    expect(owls).toBeGreaterThan(OWL_FRACTION - 0.05);
    expect(owls).toBeLessThan(OWL_FRACTION + 0.05);
    expect(chronotypeFor(fleet[3])).toEqual(chronotypeFor(fleet[3]));
  });
  it('always has an awake pool wider than the curve wants, at every minute', () => {
    for (let m = 0; m < 1440; m += 15) {
      const awake = fleet.filter((id) => isAwake(id, m)).length / fleet.length;
      expect(awake, `at ${m}`).toBeGreaterThan(attendanceFraction(m, 6));
    }
  });
  it('day people are asleep at 04:30 and owls are the ones awake', () => {
    const awake = fleet.filter((id) => isAwake(id, H(4, 30)));
    expect(awake.length).toBeGreaterThan(0);
    for (const id of awake) expect(chronotypeFor(id).owl).toBe(true);
  });
  it('minutes past bedtime grows through the night and resets on waking', () => {
    const day = fleet.find((id) => !chronotypeFor(id).owl)!;
    const { bedMinute, wakeMinute } = chronotypeFor(day);
    expect(minutesPastBedtime(day, bedMinute % 1440)).toBe(0);
    expect(minutesPastBedtime(day, (bedMinute + 30) % 1440)).toBe(30);
    expect(minutesPastBedtime(day, wakeMinute)).toBe(0);
    expect(sleepPriority(day, (bedMinute + 30) % 1440)).toBeGreaterThan(
      sleepPriority(day, (bedMinute - 30) % 1440)
    );
  });
  it('bedtime hazard rises with lateness and never exceeds 1', () => {
    expect(bedtimeLeaveProbability(0, 1.5)).toBe(0);
    expect(bedtimeLeaveProbability(1, 1.5)).toBeLessThan(bedtimeLeaveProbability(60, 1.5));
    expect(bedtimeLeaveProbability(60, 1.5)).toBeLessThan(bedtimeLeaveProbability(120, 1.5));
    expect(bedtimeLeaveProbability(500, 1.5)).toBe(1);
  });
});

describe('the trickle', () => {
  it('a cold floor fills in minutes, not one pass, and never over-fills', () => {
    let seated = 0;
    const target = 263; // 45% of 584
    let cycles = 0;
    while (seated < target && cycles < 200) {
      const b = arrivalsBudget(seated, target, 584);
      expect(b).toBeGreaterThan(0);
      expect(seated + b).toBeLessThanOrEqual(target);
      seated += b;
      cycles++;
    }
    expect(seated).toBe(target);
    expect(cycles).toBeGreaterThan(10); // more than five minutes at 30s cycles
    expect(cycles).toBeLessThan(80); // under forty minutes
    expect(arrivalsBudget(target, target, 584)).toBe(0);
  });
  it('the evening wind-down walks down one or two at a time, never a block', () => {
    // 57% -> 9% of 584 over the 21:00 -> 03:30 window at 90s cycles, on the
    // quota alone (the organic bedtime quits only make it faster).
    let seated = 333;
    for (let cycle = 0; cycle < 260; cycle++) {
      const minute = (H(21) + Math.floor(cycle * 1.5)) % 1440;
      const target = Math.round(584 * attendanceFraction(minute));
      const d = departuresBudget(seated, target);
      expect(d).toBeLessThanOrEqual(8);
      seated -= d;
    }
    expect(seated).toBeLessThanOrEqual(Math.round(584 * 0.1));
  });
  it('a deploy that finds 250 over target takes about an hour to unwind', () => {
    let seated = 250 + 130;
    let cycles = 0;
    while (seated > 130 && cycles < 1000) {
      seated -= departuresBudget(seated, 130);
      cycles++;
    }
    expect(cycles).toBeGreaterThan(30);
    expect(cycles).toBeLessThan(120);
  });
});

describe('yielding a seat to a person is not right away', () => {
  it('the first horse waits two to four minutes, then one every 1.5-3 minutes', () => {
    const since = 1_700_000_000_000;
    const first = firstYieldDelayMs('t1', since);
    expect(first).toBeGreaterThanOrEqual(120_000);
    expect(first).toBeLessThanOrEqual(240_000);
    const gap = nextYieldGapMs('t1', since + first);
    expect(gap).toBeGreaterThanOrEqual(90_000);
    expect(gap).toBeLessThanOrEqual(180_000);
    const clock = { since, lastYieldAt: null as number | null };
    expect(mayYieldNow('t1', clock, since + 30_000)).toBe(false);
    expect(mayYieldNow('t1', clock, since + first)).toBe(true);
    clock.lastYieldAt = since + first;
    expect(mayYieldNow('t1', clock, since + first + 30_000)).toBe(false);
    expect(mayYieldNow('t1', clock, since + first + gap)).toBe(true);
  });
  it('two tables do not keep the same beat', () => {
    const since = 1_700_000_000_000;
    const delays = new Set(['a', 'b', 'c', 'd', 'e', 'f'].map((t) => firstYieldDelayMs(t, since)));
    expect(delays.size).toBeGreaterThan(3);
  });
});

describe('wiring', () => {
  const fleet = readFileSync(join(process.cwd(), 'src/services/HorseFleetManager.ts'), 'utf8');
  const rot = readFileSync(join(process.cwd(), 'src/services/HorseSessionRotator.ts'), 'utf8');
  it('the fleet manager gates arrivals on the curve and no longer runs the 1/3 activity floor', () => {
    expect(fleet).toContain("from './HorseAttendance.js'");
    expect(fleet).toContain('arrivalsBudget(seated, target, roster)');
    expect(fleet).toContain('isAwake(h.id, chicagoMinute)');
    expect(fleet).not.toContain('fleetBoost');
    expect(fleet).not.toContain('isActiveNow');
  });
  it('the rotator sends sleepers home per club and paces the yield to a waiting human', () => {
    expect(rot).toContain('sendSleepersHome(');
    expect(rot).toContain('departuresBudget(seatedSet.size, target)');
    expect(rot).toContain('mayYieldNow(tableId, clock, Date.now())');
    expect(rot).toContain('if (yieldNow) {');
    expect(rot).not.toContain('isActiveNow');
  });
});
