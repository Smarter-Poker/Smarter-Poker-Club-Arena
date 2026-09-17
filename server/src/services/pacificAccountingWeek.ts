/** The accounting book closes at Monday midnight in Pacific time. The job
 * runs later at 4 AM Chicago; its wall clock does not redefine this book. */
const pacificDate = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function pacificAccountingWeek(instant: string | Date): {
  periodStart: string;
  periodEnd: string;
} {
  const date = instant instanceof Date ? instant : new Date(instant);
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid accounting earning timestamp');
  const parts = pacificDate.formatToParts(date);
  const value = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  // UTC is used only as a calendar arithmetic carrier. The date came from
  // Pacific time, so DST weeks retain their 167/169-hour database intervals.
  const calendar = new Date(Date.UTC(value('year'), value('month') - 1, value('day')));
  calendar.setUTCDate(calendar.getUTCDate() - ((calendar.getUTCDay() + 6) % 7));
  const periodStart = calendar.toISOString().slice(0, 10);
  calendar.setUTCDate(calendar.getUTCDate() + 6);
  return { periodStart, periodEnd: calendar.toISOString().slice(0, 10) };
}
