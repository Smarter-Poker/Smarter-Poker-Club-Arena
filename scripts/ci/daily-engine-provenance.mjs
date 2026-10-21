import { msUntilNextAnnouncement } from './await-engine-gameplay.mjs';

/** Expected queue only, never evidence that an unshipped change is live. */
export function queuedDailyRelease(health, oldestUnservedAt, now = Date.now()) {
  const schedule = health?.maintenance?.schedule;
  const first = Date.parse(oldestUnservedAt);
  if (
    schedule?.timeZone !== 'America/Chicago' ||
    schedule.startHour !== 4 ||
    schedule.startMinute !== 0 ||
    schedule.hourlyCashFreeze !== false ||
    !Number.isFinite(first) ||
    first > now
  )
    return null;
  // The daily preparation snapshot opens at 03:30. Missing that snapshot means
  // tomorrow's window; later merges cannot reset the oldest unserved change.
  const snapshotClock = first + 28 * 60_000 - 1;
  const announcement = snapshotClock + msUntilNextAnnouncement(snapshotClock);
  const dueAt = announcement + 2 * 60_000 + 15 * 60_000;
  return now < dueAt ? { dueAt, oldestUnservedAt: first, status: 'queued' } : null;
}
if (import.meta.url === `file://${process.argv[1]}`) {
  let body = '';
  for await (const chunk of process.stdin) body += chunk;
  let queued = null;
  try {
    queued = queuedDailyRelease(JSON.parse(body), process.argv[2]);
  } catch {}
  if (!queued) process.exitCode = 1;
  else process.stdout.write(new Date(queued.dueAt).toISOString());
}
