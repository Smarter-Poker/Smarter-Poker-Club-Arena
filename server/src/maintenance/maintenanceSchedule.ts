/** Owner schedule: routine maintenance starts at 04:00 America/Chicago. */
export const MAINTENANCE_TIME_ZONE = 'America/Chicago';
export const MAINTENANCE_START_HOUR = 4;
const chicago = new Intl.DateTimeFormat('en-US', {
  timeZone: MAINTENANCE_TIME_ZONE,
  hour: '2-digit',
  hourCycle: 'h23',
});
const DAY_MS = 24 * 60 * 60 * 1000;
export interface ScheduledMaintenanceWindow {
  announcedAt: number;
  startsAt: number;
  endsAt: number;
}

/** 04:00 is neither skipped nor repeated on either Chicago DST transition. */
export function nearbyMaintenanceWindows(at: number): ScheduledMaintenanceWindow[] {
  const midnight = Math.floor(at / DAY_MS) * DAY_MS;
  const windows: ScheduledMaintenanceWindow[] = [];
  for (let day = -1; day <= 2; day++) {
    // Chicago is UTC-5 or UTC-6. Validate with IANA rules, never the host TZ.
    for (const utcHour of [9, 10]) {
      const startsAt = midnight + day * DAY_MS + utcHour * 60 * 60 * 1000;
      if (Number(chicago.format(startsAt)) !== MAINTENANCE_START_HOUR) continue;
      windows.push({
        announcedAt: startsAt - 2 * 60 * 1000,
        startsAt,
        endsAt: startsAt + 5 * 60 * 1000,
      });
    }
  }
  return windows.sort((a, b) => a.startsAt - b.startsAt);
}
export function scheduledMaintenanceAt(at: number): ScheduledMaintenanceWindow | null {
  return nearbyMaintenanceWindows(at).find((w) => at >= w.announcedAt && at < w.endsAt) ?? null;
}
export function nextMaintenanceAnnouncement(at: number): number {
  const next = nearbyMaintenanceWindows(at).find((w) => w.announcedAt > at);
  if (!next) throw new Error('daily_maintenance_schedule_unresolvable');
  return next.announcedAt;
}
