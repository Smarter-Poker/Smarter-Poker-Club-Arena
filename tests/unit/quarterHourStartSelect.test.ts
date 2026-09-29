/**
 * SCHEDULE DATES AND TIMES ARE DROPDOWNS (owner requirement, 2026-09-20), and a
 * value that is already saved is never silently changed by becoming one.
 */
import { describe, it, expect } from 'vitest';
import {
  QUARTER_HOUR_SLOTS,
  clockLabel12,
  isCompleteLocalStart,
  joinLocalStart,
  localDateLabel,
  localDateValue,
  quarterHourOptions,
  splitLocalStart,
  upcomingDateOptions,
} from '../../src/lib/quarterHourStartSelect';
import { buildTournamentConfig } from '../../src/lib/tournamentFromTableConfig';

describe('the time dropdown', () => {
  it('offers the 96 quarter hours of a day, in order', () => {
    expect(QUARTER_HOUR_SLOTS).toHaveLength(96);
    expect(QUARTER_HOUR_SLOTS[0]).toBe('00:00');
    expect(QUARTER_HOUR_SLOTS[1]).toBe('00:15');
    expect(QUARTER_HOUR_SLOTS[95]).toBe('23:45');
    expect(quarterHourOptions('').map((o) => o.value)).toEqual([...QUARTER_HOUR_SLOTS]);
    expect(quarterHourOptions('18:00')).toHaveLength(96);
  });

  it('keeps a saved off-grid time as a selectable option, in clock order', () => {
    const values = quarterHourOptions('19:05').map((o) => o.value);
    expect(values).toHaveLength(97);
    expect(values.slice(values.indexOf('19:00'), values.indexOf('19:00') + 3)).toEqual([
      '19:00',
      '19:05',
      '19:15',
    ]);
    // After the last slot too.
    expect(quarterHourOptions('23:59').map((o) => o.value)[96]).toBe('23:59');
  });

  it('keeps a malformed saved value visible instead of dropping it', () => {
    const options = quarterHourOptions('7:5');
    expect(options[0]).toEqual({ value: '7:5', label: '7:5' });
    expect(options).toHaveLength(97);
  });

  it('labels a local time on a 12 hour clock', () => {
    expect(clockLabel12('00:00')).toBe('12:00 AM');
    expect(clockLabel12('12:15')).toBe('12:15 PM');
    expect(clockLabel12('19:05')).toBe('7:05 PM');
    expect(clockLabel12('not a time')).toBe('not a time');
  });
});

describe('the date dropdown', () => {
  const now = new Date(2026, 8, 20, 23, 30); // late on 20 Sep 2026, local

  it('starts today, in LOCAL calendar days, and runs a year', () => {
    const options = upcomingDateOptions(now, '');
    expect(options).toHaveLength(366);
    expect(options[0]).toEqual({ value: '2026-09-20', label: 'Sun, Sep 20, 2026' });
    expect(options[1].value).toBe('2026-09-21');
    expect(options[365].value).toBe('2027-09-20');
    expect(new Set(options.map((o) => o.value)).size).toBe(366);
  });

  it('keeps a saved date that is outside the window', () => {
    const past = upcomingDateOptions(now, '2026-09-01');
    expect(past[0].value).toBe('2026-09-01');
    expect(past).toHaveLength(367);
    const far = upcomingDateOptions(now, '2028-01-05');
    expect(far[366].value).toBe('2028-01-05');
  });

  it('reads the date from local fields', () => {
    expect(localDateValue(new Date(2026, 0, 5, 0, 1))).toBe('2026-01-05');
    expect(localDateValue(new Date(2026, 11, 31, 23, 59))).toBe('2026-12-31');
    expect(localDateLabel('2026-02-30')).toBe('2026-02-30');
  });
});

describe('the two halves of the start string', () => {
  it('round-trips the exact string a datetime-local input emitted', () => {
    for (const value of ['2026-10-03T19:00', '2026-10-03T19:05', '2026-10-03T19:05:30', '']) {
      const { date, time } = splitLocalStart(value);
      expect(joinLocalStart(date, time)).toBe(value);
    }
    expect(splitLocalStart('2026-10-03T19:05')).toEqual({ date: '2026-10-03', time: '19:05' });
  });

  it('carries a half-made choice without losing either half', () => {
    expect(joinLocalStart('2026-10-03', '')).toBe('2026-10-03T');
    expect(splitLocalStart('2026-10-03T')).toEqual({ date: '2026-10-03', time: '' });
    expect(joinLocalStart('', '19:00')).toBe('T19:00');
    expect(splitLocalStart('T19:00')).toEqual({ date: '', time: '19:00' });
    expect(isCompleteLocalStart('2026-10-03T')).toBe(false);
    expect(isCompleteLocalStart('T19:00')).toBe(false);
    expect(isCompleteLocalStart('')).toBe(false);
    expect(isCompleteLocalStart('2026-10-03T19:05')).toBe(true);
  });

  it('changing only the date keeps an off-grid time, and the mapper reads it as local time', () => {
    const future = new Date(Date.now() + 3 * 86_400_000);
    const saved = `${localDateValue(future)}T19:05`;
    const { time } = splitLocalStart(saved);
    const nextDay = localDateValue(new Date(future.getTime() + 86_400_000));
    const moved = joinLocalStart(nextDay, time);
    expect(moved).toBe(`${nextDay}T19:05`);

    const c = buildTournamentConfig(
      {
        name: 'Start Test',
        gameMode: 'mtt',
        buyIn: 50,
        startingChips: 10000,
        blindStructure: 'standard',
        blindsUpMinutes: 8,
        payoutStructure: 'payout1',
        sngPlayerCount: 9,
        isSpins: false,
        minPlayers: 10,
        lateRegistrationLevel: 6,
        numberOfRebuysReentries: 0,
        addOnMultiplier: 0,
        koBounty: false,
        startTime: moved,
      },
      'nlh'
    );
    const start = c.startTime as Date;
    // Local wall clock, exactly as typed: 19:05 on the chosen local day.
    expect(localDateValue(start)).toBe(nextDay);
    expect(start.getHours()).toBe(19);
    expect(start.getMinutes()).toBe(5);
  });

  it('half a start is no start for the mapper, which is why the form refuses it first', () => {
    const c = buildTournamentConfig(
      {
        name: 'Half Start',
        gameMode: 'mtt',
        buyIn: 50,
        startingChips: 10000,
        blindStructure: 'standard',
        blindsUpMinutes: 8,
        payoutStructure: 'payout1',
        sngPlayerCount: 9,
        isSpins: false,
        minPlayers: 10,
        lateRegistrationLevel: 6,
        numberOfRebuysReentries: 0,
        addOnMultiplier: 0,
        koBounty: false,
        startTime: '2099-10-03T',
      },
      'nlh'
    );
    expect(c.startTime).toBeUndefined();
  });
});
