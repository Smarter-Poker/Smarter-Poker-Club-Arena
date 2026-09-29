/**
 * QUARTER-HOUR START SELECTS (2026-09-20)
 *
 * Owner requirement: a schedule date and a schedule time are chosen from
 * dropdowns, never typed into a native date or time picker. This module is the
 * one place that builds those dropdown options, shared by the weekly schedule
 * editor (UTC, 24-hour `HH:MM`) and the create-table tournament form (the
 * local `YYYY-MM-DDTHH:MM` string a `datetime-local` input used to emit).
 *
 * THE RULE THAT MATTERS: a value that is already saved is never silently
 * changed. A stored `19:05` is not on the 15-minute grid, so it is added to the
 * options in order and stays selected until a person picks something else. The
 * same holds for a saved date that has since fallen out of the offered range.
 *
 * Pure functions, no React, no Supabase, so the conversions are unit tested.
 */

export interface StartSelectOption {
  value: string;
  label: string;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** The 96 quarter-hour slots of a day as 24-hour `HH:MM`. */
export const QUARTER_HOUR_SLOTS: readonly string[] = Array.from({ length: 96 }, (_, index) => {
  return `${pad2(Math.floor(index / 4))}:${pad2((index % 4) * 15)}`;
});

/** `HH:MM` on a 24-hour clock, optionally with `:SS` the way a saved value may carry. */
const CLOCK_PATTERN = /^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9](\.[0-9]+)?)?$/;

/** 24-hour label: the value itself. Used where the clock is UTC. */
export const clockLabel24 = (value: string): string => value;

/** 12-hour label with the day period spelled out. Locale independent on purpose. */
export function clockLabel12(value: string): string {
  if (!CLOCK_PATTERN.test(value)) return value;
  const hour = Number(value.slice(0, 2));
  const rest = value.slice(2);
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${hour12}${rest} ${hour < 12 ? 'AM' : 'PM'}`;
}

/**
 * The time dropdown: every quarter hour, plus `existing` when it is set and
 * off the grid. A well formed off-grid time is placed in clock order; anything
 * else that is non-empty is kept first so it is visible and still selected.
 */
export function quarterHourOptions(
  existing: string | null | undefined,
  labelFor: (value: string) => string = clockLabel24
): StartSelectOption[] {
  const options = QUARTER_HOUR_SLOTS.map((value) => ({ value, label: labelFor(value) }));
  const current = existing ?? '';
  if (current === '' || QUARTER_HOUR_SLOTS.includes(current)) return options;
  const extra = { value: current, label: labelFor(current) };
  if (!CLOCK_PATTERN.test(current)) return [extra, ...options];
  const at = options.findIndex((option) => option.value > current);
  if (at === -1) return [...options, extra];
  return [...options.slice(0, at), extra, ...options.slice(at)];
}

/** A local calendar date as `YYYY-MM-DD`, read from the local fields (never via UTC). */
export function localDateValue(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `Sun, Sep 20, 2026`. Locale independent so a render and a test agree. */
export function localDateLabel(value: string): string {
  if (!DATE_PATTERN.test(value)) return value;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(y, m - 1, d, 12, 0, 0, 0);
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) return value;
  return `${WEEKDAYS[date.getDay()]}, ${MONTHS[date.getMonth()]} ${date.getDate()}, ${y}`;
}

/**
 * The date dropdown: today and the following `days - 1` local calendar days,
 * plus `existing` when it is set and outside that window (placed in order).
 */
export function upcomingDateOptions(
  now: Date,
  existing: string | null | undefined,
  days = 366
): StartSelectOption[] {
  const values: string[] = [];
  for (let offset = 0; offset < days; offset++) {
    // Noon, so a daylight-saving shift can never push the date over midnight.
    values.push(
      localDateValue(new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset, 12))
    );
  }
  const current = existing ?? '';
  if (current !== '' && !values.includes(current)) {
    const at = DATE_PATTERN.test(current) ? values.findIndex((value) => value > current) : 0;
    if (at === -1) values.push(current);
    else values.splice(at, 0, current);
  }
  return values.map((value) => ({ value, label: localDateLabel(value) }));
}

/**
 * Split the form's local start string (`YYYY-MM-DDTHH:MM`, the exact format a
 * `datetime-local` input emitted) into its two dropdown values. A half-made
 * choice is carried as `YYYY-MM-DDT` or `THH:MM`, so neither half is lost
 * while the other is still unpicked.
 */
export function splitLocalStart(value: string | null | undefined): { date: string; time: string } {
  const raw = value ?? '';
  const at = raw.indexOf('T');
  if (at === -1) return { date: raw, time: '' };
  return { date: raw.slice(0, at), time: raw.slice(at + 1) };
}

/** The inverse of splitLocalStart. Both halves empty is the empty string. */
export function joinLocalStart(date: string, time: string): string {
  if (date === '' && time === '') return '';
  return `${date}T${time}`;
}

/** True only when both halves are present, so `new Date(value)` is a real local instant. */
export function isCompleteLocalStart(value: string | null | undefined): boolean {
  const { date, time } = splitLocalStart(value);
  return date !== '' && time !== '';
}
