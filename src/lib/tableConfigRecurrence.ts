/**
 * CREATE-TABLE MTT RECURRENCE (2026-09-20)
 *
 * The create-table MTT tab could only repeat weekly. The owner requirement is
 * one control at the bottom of the form: Does Not Repeat, Daily, Weekly or
 * Monthly. This is the pure mapping from that control to what is saved, kept
 * out of the page so it can be tested without rendering it.
 *
 * Nothing new is invented on the wire. A repeating event is a
 * `tournament_schedules` row written by fn_upsert_tournament_schedule, and its
 * `config` carries the same two keys the club tournament modal already sends
 * and the engine's spawner already reads
 * (server/src/services/ScheduledTournamentService.ts, processTimedSchedule):
 *
 *   recurrenceCadence     'daily' | 'weekly' | 'monthly'
 *   recurrenceDayOfMonth  1..31, monthly only
 *
 * The spawner reads the cadence from TIMED schedules only, so Daily and
 * Monthly are always saved as set times on all seven days: Daily runs every
 * one of them, and Monthly keeps only the occurrences whose UTC date is the
 * chosen day. A month that does not have that day is skipped.
 */
import type { WeeklyScheduleValue } from '../components/tournament/WeeklyScheduleEditor';

export type RecurrenceCadence = 'daily' | 'weekly' | 'monthly';
export type RepeatChoice = 'none' | RecurrenceCadence;

export const REPEAT_CHOICES: readonly { value: RepeatChoice; label: string }[] = [
  { value: 'none', label: 'Does Not Repeat' },
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
];

export const EVERY_DAY_OF_THE_WEEK: readonly number[] = [0, 1, 2, 3, 4, 5, 6];

/** The days a month can have, for the Day Of Month dropdown. */
export const DAYS_OF_MONTH: readonly number[] = Array.from({ length: 31 }, (_, i) => i + 1);

/** Shown beside a Day Of Month that some months do not have. Empty otherwise. */
export function shortMonthHint(dayOfMonth: number): string {
  if (dayOfMonth >= 31) return 'Months With Fewer Than 31 Days Are Skipped.';
  if (dayOfMonth === 30) return 'February Is Skipped, Because It Has No 30th.';
  if (dayOfMonth === 29) return 'February Is Skipped Unless It Is A Leap Year.';
  return '';
}

export const clampDayOfMonth = (day: unknown): number =>
  Math.min(31, Math.max(1, Math.round(Number(day)) || 1));

export function isRecurrenceCadence(value: unknown): value is RecurrenceCadence {
  return value === 'daily' || value === 'weekly' || value === 'monthly';
}

/** What the Repeat dropdown shows for a form state (older drafts have no cadence: weekly). */
export function repeatChoiceFor(draft: {
  tournamentSchedule?: boolean;
  scheduleCadence?: unknown;
}): RepeatChoice {
  if (!draft.tournamentSchedule) return 'none';
  return isRecurrenceCadence(draft.scheduleCadence) ? draft.scheduleCadence : 'weekly';
}

export interface RecurrenceSave {
  /** What validateWeeklySchedule checks and the schedule row stores. */
  schedule: WeeklyScheduleValue;
  /** Merged into the schedule's `config`, beside the tournament's own keys. */
  configKeys: { recurrenceCadence: RecurrenceCadence; recurrenceDayOfMonth?: number };
}

export function recurrenceForSave(input: {
  cadence: RecurrenceCadence;
  dayOfMonth: number;
  schedule: WeeklyScheduleValue;
}): RecurrenceSave {
  const startTimesUtc = input.schedule.startTimesUtc.filter((t) => t.trim() !== '');
  if (input.cadence === 'weekly') {
    return {
      schedule: { ...input.schedule, startTimesUtc },
      configKeys: { recurrenceCadence: 'weekly' },
    };
  }
  return {
    schedule: {
      ...input.schedule,
      startTimesUtc,
      daysOfWeek: [...EVERY_DAY_OF_THE_WEEK],
      mode: 'times',
    },
    configKeys:
      input.cadence === 'monthly'
        ? { recurrenceCadence: 'monthly', recurrenceDayOfMonth: clampDayOfMonth(input.dayOfMonth) }
        : { recurrenceCadence: 'daily' },
  };
}
