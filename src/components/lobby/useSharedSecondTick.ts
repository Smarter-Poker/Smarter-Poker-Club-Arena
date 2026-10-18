import { useEffect, useState } from 'react';

const tickSubscribers = new Set<() => void>();
let tickInterval: ReturnType<typeof setInterval> | null = null;
export function useSharedSecondTick(active = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const cb = () => setNow(Date.now());
    tickSubscribers.add(cb);
    if (tickInterval == null)
      tickInterval = setInterval(() => {
        tickSubscribers.forEach((f) => f());
      }, 1000);
    return () => {
      tickSubscribers.delete(cb);
      if (tickSubscribers.size === 0 && tickInterval != null) {
        clearInterval(tickInterval);
        tickInterval = null;
      }
    };
  }, [active]);
  return now;
}
