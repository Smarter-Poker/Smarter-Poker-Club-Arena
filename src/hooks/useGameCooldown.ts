import { useEffect, useState } from 'react';

/** Display a server-issued wait locally; admission still checks the server clock. */
export function useGameCooldown() {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (seconds <= 0) return;
    const timer = window.setTimeout(() => setSeconds((s) => Math.max(0, s - 1)), 1000);
    return () => window.clearTimeout(timer);
  }, [seconds]);
  return [seconds, setSeconds] as const;
}
