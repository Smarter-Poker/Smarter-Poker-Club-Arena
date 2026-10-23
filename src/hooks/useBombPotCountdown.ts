import { useEffect, useState } from 'react';

/** Display-only clock. The engine still decides when the bomb pot is dealt. */
export function useBombPotCountdown(
  nextAt: number | null | undefined,
  announceSeconds = 0,
  enabled = true
): string | null {
  const [label, setLabel] = useState<string | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      clearTimeout(timer);
      if (!enabled || nextAt == null) {
        setLabel(null);
        return;
      }
      // Safari may suspend a page for minutes. Re-read wall time on resume;
      // never count missed callbacks or run a hidden display clock.
      if (document.visibilityState === 'hidden') return;
      const remaining = nextAt - Date.now();
      if (remaining <= 0) {
        setLabel('NEXT HAND');
        return;
      }
      const quietFor = announceSeconds > 0 ? remaining - announceSeconds * 1000 : 0;
      if (quietFor > 0) {
        setLabel(null);
        timer = setTimeout(update, Math.min(quietFor, 2_147_483_647));
        return;
      }
      const seconds = Math.ceil(remaining / 1000);
      const rest = (seconds % 60).toLocaleString('en-US', {
        minimumIntegerDigits: 2,
        useGrouping: false,
      });
      setLabel(`${Math.floor(seconds / 60)}:${rest}`);
      timer = setTimeout(update, Math.max(1, remaining - (seconds - 1) * 1000));
    };
    const resume = () => update();
    update();
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('pageshow', resume);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', resume);
      window.removeEventListener('pageshow', resume);
    };
  }, [nextAt, announceSeconds, enabled]);

  return label;
}
