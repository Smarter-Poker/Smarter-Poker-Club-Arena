/**
 * THE MTT TAB REPEATS DAILY, WEEKLY OR MONTHLY (owner requirement, 2026-09-20).
 * Pins the mapping to the keys the club tournament modal sends and the
 * engine's spawner reads: recurrenceCadence and recurrenceDayOfMonth.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  DAYS_OF_MONTH,
  REPEAT_CHOICES,
  clampDayOfMonth,
  recurrenceForSave,
  repeatChoiceFor,
  shortMonthHint,
} from '../../src/lib/tableConfigRecurrence';
import { validateWeeklySchedule } from '../../src/components/tournament/WeeklyScheduleEditor';

const schedule = {
  daysOfWeek: [2, 4],
  startTimesUtc: ['18:00', ' ', '19:05'],
  mode: 'interval' as const,
  intervalMinutes: 90,
};

describe('the Repeat control', () => {
  it('offers exactly the four choices, in order, in Title Case', () => {
    expect(REPEAT_CHOICES.map((c) => c.label)).toEqual([
      'Does Not Repeat',
      'Daily',
      'Weekly',
      'Monthly',
    ]);
  });

  it('shows an older draft that only had the schedule switch as Weekly', () => {
    expect(repeatChoiceFor({ tournamentSchedule: false, scheduleCadence: 'monthly' })).toBe('none');
    expect(repeatChoiceFor({ tournamentSchedule: true })).toBe('weekly');
    expect(repeatChoiceFor({ tournamentSchedule: true, scheduleCadence: 'daily' })).toBe('daily');
    expect(repeatChoiceFor({ tournamentSchedule: true, scheduleCadence: 'hourly' })).toBe('weekly');
  });
});

describe('what is saved', () => {
  it('weekly keeps the chosen days and mode, and says weekly', () => {
    const r = recurrenceForSave({ cadence: 'weekly', dayOfMonth: 9, schedule });
    expect(r.schedule.daysOfWeek).toEqual([2, 4]);
    expect(r.schedule.mode).toBe('interval');
    expect(r.schedule.startTimesUtc).toEqual(['18:00', '19:05']);
    expect(r.configKeys).toEqual({ recurrenceCadence: 'weekly' });
  });

  it('daily is set times on all seven days', () => {
    const r = recurrenceForSave({ cadence: 'daily', dayOfMonth: 9, schedule });
    expect(r.schedule.daysOfWeek).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(r.schedule.mode).toBe('times');
    expect(r.configKeys).toEqual({ recurrenceCadence: 'daily' });
    expect(validateWeeklySchedule(r.schedule)).toBeNull();
  });

  it('monthly carries the day of the month, clamped to 1..31', () => {
    const r = recurrenceForSave({ cadence: 'monthly', dayOfMonth: 31, schedule });
    expect(r.schedule.daysOfWeek).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(r.schedule.mode).toBe('times');
    expect(r.configKeys).toEqual({ recurrenceCadence: 'monthly', recurrenceDayOfMonth: 31 });
    expect(
      recurrenceForSave({ cadence: 'monthly', dayOfMonth: 99, schedule }).configKeys
        .recurrenceDayOfMonth
    ).toBe(31);
    expect(clampDayOfMonth('0')).toBe(1);
    expect(DAYS_OF_MONTH).toHaveLength(31);
  });

  it('a daily or monthly schedule with no start time is still refused', () => {
    const r = recurrenceForSave({
      cadence: 'daily',
      dayOfMonth: 1,
      schedule: { ...schedule, startTimesUtc: [''] },
    });
    expect(validateWeeklySchedule(r.schedule)).toBe('Add At Least One Start Time.');
  });

  it('never touches the draft it was handed', () => {
    const frozen = Object.freeze({ ...schedule, daysOfWeek: Object.freeze([2, 4]) as number[] });
    recurrenceForSave({ cadence: 'monthly', dayOfMonth: 5, schedule: frozen });
    expect(frozen.daysOfWeek).toEqual([2, 4]);
  });
});

describe('the short-month hint', () => {
  it('speaks only for days some months do not have', () => {
    for (let day = 1; day <= 28; day++) expect(shortMonthHint(day)).toBe('');
    expect(shortMonthHint(29)).toContain('Leap Year');
    expect(shortMonthHint(30)).toContain('February');
    expect(shortMonthHint(31)).toContain('Fewer Than 31 Days');
  });
});

describe('the keys are the ones the spawner and the club modal use', () => {
  const read = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), ...p), 'utf8');

  it('the engine reads them from the schedule config', () => {
    const spawner = read('server', 'src', 'services', 'ScheduledTournamentService.ts');
    expect(spawner).toContain('cfg.recurrenceCadence');
    expect(spawner).toContain('cfg.recurrenceDayOfMonth');
  });

  it('the create-table page sends them with the schedule and offers no native pickers', () => {
    const page = read('src', 'pages', 'TableConfigPage.tsx');
    expect(page).toContain('Object.assign(rpcConfig, recurrence.configKeys)');
    expect(page).toContain("hideInterval={repeatChoice !== 'weekly'}");
    expect(page).not.toContain('type="datetime-local"');
    expect(page).not.toContain('type="time"');
    expect(page).not.toContain('type="date"');
  });
});
