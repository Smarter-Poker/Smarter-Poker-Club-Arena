/**
 * CLUB DATA COUNTS CHICAGO DAYS (Dan, 2026-10-22).
 *
 * Club Data and Union Data count the America/Chicago calendar day, daylight
 * saving included, because the server buckets every figure that way
 * (migrations 20261022103651 and 20261022120121). A day on these pages starts
 * at Chicago midnight, so the page's own "today", the period presets and every
 * time it prints are Chicago too. A bare UTC date here would put the evening's
 * play on tomorrow again, which is exactly what this change removed.
 *
 * Dates are carried as YYYY-MM-DD calendar strings. Calendar arithmetic on
 * those strings does not depend on any zone; only "what is today" and "what
 * time was it" do, and those are answered here.
 */
export const CLUB_DATA_TIME_ZONE = 'America/Chicago';
/** The short badge printed beside a range or a time. */
export const CLUB_DATA_ZONE_LABEL = 'Chicago Time';

const dayFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: CLUB_DATA_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** The Chicago calendar date of an instant, as YYYY-MM-DD. */
export function chicagoDay(at: Date | string | number = new Date()): string {
  const d = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(d.getTime())) return '';
  const parts = Object.fromEntries(dayFormat.formatToParts(d).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** A calendar date moved by whole days. Zone free: the date is a label. */
export function addCalendarDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** HH:MM of an instant on the Chicago clock. */
export function chicagoClock(at: Date | string | number): string {
  const d = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('en-GB', {
    timeZone: CLUB_DATA_TIME_ZONE,
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** MM/DD HH:MM of an instant on the Chicago clock. */
export function chicagoStamp(at: Date | string | number): string {
  const d = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(d.getTime())) return '';
  const day = chicagoDay(d);
  return `${day.slice(5, 7)}/${day.slice(8, 10)} ${chicagoClock(d)}`;
}
