import { useEffect, useState } from 'react';

/* One shared once-a-minute clock for labels like "Seen 12 Mins Ago", so a long
 * player list keeps every row current with a single timer instead of one per
 * row. Rows that do not need it pass active=false and never subscribe. */
const subscribers = new Set<() => void>();
let interval: ReturnType<typeof setInterval> | null = null;

export function useSharedMinuteTick(active = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const tick = () => setNow(Date.now());
    tick();
    subscribers.add(tick);
    if (interval == null)
      interval = setInterval(() => {
        subscribers.forEach((f) => f());
      }, 60_000);
    return () => {
      subscribers.delete(tick);
      if (subscribers.size === 0 && interval != null) {
        clearInterval(interval);
        interval = null;
      }
    };
  }, [active]);
  return now;
}
