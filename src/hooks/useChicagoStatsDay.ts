import { useEffect, useState } from 'react';
import {
  accountingDateOnly,
  zonedAccountingDate,
  zonedAccountingInstant,
} from '../utils/pacificAccountingCalendar';

export const chicagoStatsDay = (at: number) => zonedAccountingDate(new Date(at), 'America/Chicago');

export function nextChicagoStatsMidnight(at: number): number {
  const next = accountingDateOnly(chicagoStatsDay(at));
  next.setUTCDate(next.getUTCDate() + 1);
  return Date.parse(zonedAccountingInstant(next.toISOString().slice(0, 10), 0, 'America/Chicago'));
}

/** One calendar-boundary event; focus also catches a browser suspended overnight. */
export function useChicagoStatsDay(): string {
  const [day, setDay] = useState(() => chicagoStatsDay(Date.now()));
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const update = () => {
      clearTimeout(timer);
      const now = Date.now();
      setDay(chicagoStatsDay(now));
      timer = setTimeout(update, Math.max(1, nextChicagoStatsMidnight(now) - now));
    };
    update();
    window.addEventListener('focus', update);
    document.addEventListener('visibilitychange', update);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('focus', update);
      document.removeEventListener('visibilitychange', update);
    };
  }, []);
  return day;
}
