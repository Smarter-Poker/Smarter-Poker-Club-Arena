/** Heads-up only. The engine's actual maintenance event owns freeze/release. */
const chicagoClock = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Chicago',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});
export function isRoutineMaintenanceUpcoming(at: number): boolean {
  const parts = chicagoClock.formatToParts(at);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value);
  return hour === 3 && minute >= 55 && minute < 58;
}
