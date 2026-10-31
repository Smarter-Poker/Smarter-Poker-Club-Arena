/* PLAYER LIST LAST SEEN TO THE MINUTE (Dan, 2026-10-31): "IF ITS 'SEEN TODAY'
 * CHANGE IT TO SEEN AN HOUR AGO, OR 2 HOURS AGO. OR TO THE MINUTE IF THE DATA
 * IS AVAILABLE". The roster's last_login is a full timestamp (the latest of
 * sign-in, presence and member activity), so inside the last day the row says
 * how many minutes or hours ago; past a day it keeps the compact day/month/year
 * age ("Seen 8d Ago"). */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Milliseconds since `iso`, or null when it is not a readable time. */
function ageMs(iso: string, now: number): number | null {
  const time = new Date(iso).getTime();
  if (!Number.isFinite(time)) return null;
  return Math.max(0, now - time);
}

/** True while the label still counts minutes or hours (it changes each minute). */
export function lastSeenIsWithinADay(iso: string, now: number = Date.now()): boolean {
  const age = ageMs(iso, now);
  return age !== null && age < DAY;
}

export function memberLastSeenLabel(iso: string, now: number = Date.now()): string {
  const age = ageMs(iso, now);
  if (age === null) return '';
  if (age < MINUTE) return 'Seen Just Now';
  if (age < HOUR) {
    const minutes = Math.floor(age / MINUTE);
    return `Seen ${minutes} ${minutes === 1 ? 'Min' : 'Mins'} Ago`;
  }
  if (age < DAY) {
    const hours = Math.floor(age / HOUR);
    return `Seen ${hours} ${hours === 1 ? 'Hour' : 'Hours'} Ago`;
  }
  const days = Math.floor(age / DAY);
  if (days < 30) return `Seen ${days}d Ago`;
  if (days < 365) return `Seen ${Math.floor(days / 30)}mo Ago`;
  return `Seen ${Math.floor(days / 365)}y Ago`;
}
