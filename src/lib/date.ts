/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  DATE UTILITIES — Date/Time Formatting & Manipulation
 * ═══════════════════════════════════════════════════════════════════════════════
 */

// ═══════════════════════════════════════════════════════════════════════════════
// FORMATTING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Format date to localized string
 */
export function formatDate(
  date: Date | string | number,
  options: Intl.DateTimeFormatOptions = { dateStyle: 'medium' }
): string {
  const d = date instanceof Date ? date : new Date(date);
  return new Intl.DateTimeFormat(undefined, options).format(d);
}

/**
 * Format time to localized string
 */
export function formatTime(
  date: Date | string | number,
  options: Intl.DateTimeFormatOptions = { timeStyle: 'short' }
): string {
  const d = date instanceof Date ? date : new Date(date);
  return new Intl.DateTimeFormat(undefined, options).format(d);
}

/**
 * Format date and time together
 */
export function formatDateTime(
  date: Date | string | number,
  options: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' }
): string {
  const d = date instanceof Date ? date : new Date(date);
  return new Intl.DateTimeFormat(undefined, options).format(d);
}

/**
 * Format relative time (e.g., "2 hours ago", "in 3 days")
 */
export function formatRelative(date: Date | string | number): string {
  const d = date instanceof Date ? date : new Date(date);
  const now = new Date();
  const diffMs = d.getTime() - now.getTime();
  const diffSec = Math.round(diffMs / 1000);
  const diffMin = Math.round(diffSec / 60);
  const diffHr = Math.round(diffMin / 60);
  const diffDay = Math.round(diffHr / 24);
  const diffWeek = Math.round(diffDay / 7);
  const diffMonth = Math.round(diffDay / 30);
  const diffYear = Math.round(diffDay / 365);

  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

  if (Math.abs(diffSec) < 60) {
    return rtf.format(diffSec, 'second');
  }
  if (Math.abs(diffMin) < 60) {
    return rtf.format(diffMin, 'minute');
  }
  if (Math.abs(diffHr) < 24) {
    return rtf.format(diffHr, 'hour');
  }
  if (Math.abs(diffDay) < 7) {
    return rtf.format(diffDay, 'day');
  }
  if (Math.abs(diffWeek) < 4) {
    return rtf.format(diffWeek, 'week');
  }
  if (Math.abs(diffMonth) < 12) {
    return rtf.format(diffMonth, 'month');
  }
  return rtf.format(diffYear, 'year');
}

/**
 * Format duration in seconds to human readable string
 */
export function formatDuration(seconds: number): string {
  if (seconds < 0) return '0:00';

  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  if (hrs > 0) {
    return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

/**
 * Format countdown timer
 */
export function formatCountdown(seconds: number): {
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
  formatted: string;
} {
  if (seconds <= 0) {
    return { days: 0, hours: 0, minutes: 0, seconds: 0, formatted: '00:00:00' };
  }

  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  let formatted: string;
  if (days > 0) {
    formatted = `${days}d ${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  } else {
    formatted = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }

  return { days, hours, minutes, seconds: secs, formatted };
}

/**
 * Format relative time — SHORT abbreviated form (e.g., "5m ago", "2h ago")
 * Used by notifications, activity feeds, chat timestamps, etc.
 */
export function formatRelativeShort(date: Date | string | number): string {
  const d = date instanceof Date ? date : new Date(date);
  const diff = (Date.now() - d.getTime()) / 1000;

  if (diff < 60) return 'Just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;

  return d.toLocaleDateString();
}

/**
 * Format minutes to human-readable duration (e.g., "2h 15m", "45m")
 * Used by session history, tournament stats, etc.
 */
export function formatDurationMinutes(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPARISONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Check if date is today
 */
export function isToday(date: Date | string | number): boolean {
  const d = date instanceof Date ? date : new Date(date);
  const today = new Date();
  return (
    d.getDate() === today.getDate() &&
    d.getMonth() === today.getMonth() &&
    d.getFullYear() === today.getFullYear()
  );
}

/**
 * Check if date is yesterday
 */
export function isYesterday(date: Date | string | number): boolean {
  const d = date instanceof Date ? date : new Date(date);
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  return (
    d.getDate() === yesterday.getDate() &&
    d.getMonth() === yesterday.getMonth() &&
    d.getFullYear() === yesterday.getFullYear()
  );
}

/**
 * Check if date is tomorrow
 */
export function isTomorrow(date: Date | string | number): boolean {
  const d = date instanceof Date ? date : new Date(date);
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  return (
    d.getDate() === tomorrow.getDate() &&
    d.getMonth() === tomorrow.getMonth() &&
    d.getFullYear() === tomorrow.getFullYear()
  );
}

/**
 * Check if date is in the past
 */
export function isPast(date: Date | string | number): boolean {
  const d = date instanceof Date ? date : new Date(date);
  return d.getTime() < Date.now();
}

/**
 * Check if date is in the future
 */
export function isFuture(date: Date | string | number): boolean {
  const d = date instanceof Date ? date : new Date(date);
  return d.getTime() > Date.now();
}

/**
 * Check if two dates are the same day
 */
export function isSameDay(date1: Date | string | number, date2: Date | string | number): boolean {
  const d1 = date1 instanceof Date ? date1 : new Date(date1);
  const d2 = date2 instanceof Date ? date2 : new Date(date2);
  return (
    d1.getDate() === d2.getDate() &&
    d1.getMonth() === d2.getMonth() &&
    d1.getFullYear() === d2.getFullYear()
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// MANIPULATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Add time to a date
 */
export function addTime(
  date: Date | string | number,
  amount: number,
  unit: 'seconds' | 'minutes' | 'hours' | 'days' | 'weeks' | 'months' | 'years'
): Date {
  const d = date instanceof Date ? new Date(date) : new Date(date);

  switch (unit) {
    case 'seconds':
      d.setSeconds(d.getSeconds() + amount);
      break;
    case 'minutes':
      d.setMinutes(d.getMinutes() + amount);
      break;
    case 'hours':
      d.setHours(d.getHours() + amount);
      break;
    case 'days':
      d.setDate(d.getDate() + amount);
      break;
    case 'weeks':
      d.setDate(d.getDate() + amount * 7);
      break;
    case 'months':
      d.setMonth(d.getMonth() + amount);
      break;
    case 'years':
      d.setFullYear(d.getFullYear() + amount);
      break;
  }

  return d;
}

/**
 * Get start of day
 */
export function startOfDay(date: Date | string | number = new Date()): Date {
  const d = date instanceof Date ? new Date(date) : new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Get end of day
 */
export function endOfDay(date: Date | string | number = new Date()): Date {
  const d = date instanceof Date ? new Date(date) : new Date(date);
  d.setHours(23, 59, 59, 999);
  return d;
}

/**
 * Get difference between two dates in specified unit
 */
export function dateDiff(
  date1: Date | string | number,
  date2: Date | string | number,
  unit: 'seconds' | 'minutes' | 'hours' | 'days'
): number {
  const d1 = date1 instanceof Date ? date1 : new Date(date1);
  const d2 = date2 instanceof Date ? date2 : new Date(date2);
  const diffMs = d2.getTime() - d1.getTime();

  switch (unit) {
    case 'seconds':
      return Math.floor(diffMs / 1000);
    case 'minutes':
      return Math.floor(diffMs / (1000 * 60));
    case 'hours':
      return Math.floor(diffMs / (1000 * 60 * 60));
    case 'days':
      return Math.floor(diffMs / (1000 * 60 * 60 * 24));
    default:
      return diffMs;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// POKER-SPECIFIC
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Format tournament start time with smart labeling
 */
export function formatTournamentTime(date: Date | string | number): string {
  const d = date instanceof Date ? date : new Date(date);

  if (isToday(d)) {
    return `Today at ${formatTime(d)}`;
  }
  if (isTomorrow(d)) {
    return `Tomorrow at ${formatTime(d)}`;
  }
  if (isPast(d)) {
    return formatRelative(d);
  }

  return formatDateTime(d);
}

/**
 * Get time until event
 */
export function getTimeUntil(date: Date | string | number): {
  past: boolean;
  seconds: number;
  formatted: string;
} {
  const d = date instanceof Date ? date : new Date(date);
  const now = new Date();
  const diffMs = d.getTime() - now.getTime();
  const past = diffMs < 0;
  const seconds = Math.abs(Math.floor(diffMs / 1000));

  return {
    past,
    seconds,
    formatted: past ? `${formatDuration(seconds)} ago` : `in ${formatDuration(seconds)}`,
  };
}
