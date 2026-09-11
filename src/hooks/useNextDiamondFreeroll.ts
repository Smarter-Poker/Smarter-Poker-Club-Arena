/**
 * useNextDiamondFreeroll - the start time of the next Diamond Arena freeroll.
 *
 * Dan 2026-09-09: the Diamond Arena card in the lobby carousel carries a
 * "Next Freeroll Starts In X:XX" timer. A freeroll is a 0 buy-in tournament
 * (FREEROLLS ARE FREE BUY, 2026-09-02), and the next one is the earliest
 * REGISTERING tournament in the Diamond Arena club whose start is still ahead.
 *
 * The hook resolves ONE row and hands back its start as epoch milliseconds;
 * the card ticks the countdown itself once a second, so this only talks to
 * the database once a minute and again the moment a countdown expires (the
 * freeroll that just started is no longer "next").
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';
import { DIAMOND_ARENA_CLUB_ID } from '../lib/constants';
import { reportError } from '../utils/errorReporter';

export const DIAMOND_FREEROLL_POLL_MS = 60_000;

export interface NextDiamondFreeroll {
  /** Epoch ms of the next freeroll's start, or null when none is scheduled. */
  startsAt: number | null;
  /** Its name, for the tooltip. */
  name: string | null;
  /** True once the first read has answered, right or wrong. */
  resolved: boolean;
  /** Ask again now (the card calls this when its countdown hits zero). */
  refresh: () => void;
}

export function useNextDiamondFreeroll(enabled = true): NextDiamondFreeroll {
  const [startsAt, setStartsAt] = useState<number | null>(null);
  const [name, setName] = useState<string | null>(null);
  const [resolved, setResolved] = useState(false);
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;

    const read = async () => {
      if (typeof navigator !== 'undefined' && !navigator.onLine) return;
      const { data, error } = await supabase
        .from('tournaments')
        .select('id, name, start_time')
        .eq('club_id', DIAMOND_ARENA_CLUB_ID)
        .eq('buy_in_amount', 0)
        .eq('status', 'REGISTERING')
        .gt('start_time', new Date().toISOString())
        .order('start_time', { ascending: true })
        .limit(1)
        .maybeSingle();
      if (!alive) return;
      if (error) {
        reportError(error, 'useNextDiamondFreeroll');
        setResolved(true);
        return;
      }
      const ms = data?.start_time ? Date.parse(data.start_time) : NaN;
      setStartsAt(Number.isFinite(ms) ? ms : null);
      setName(data?.name ?? null);
      setResolved(true);
    };

    void read();
    const poll = window.setInterval(() => void read(), DIAMOND_FREEROLL_POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(poll);
    };
  }, [enabled, nonce]);

  return { startsAt, name, resolved, refresh };
}

export default useNextDiamondFreeroll;

/** Inside this many seconds the clock is about to matter; the surface reddens. */
export const FREEROLL_IMMINENT_SECONDS = 10;

/** "M:SS" under an hour, "H:MM:SS" under a day, "2d 4h" beyond. */
export function formatFreerollCountdown(seconds: number): string {
  if (seconds >= 86_400) {
    const days = Math.floor(seconds / 86_400);
    const hours = Math.floor((seconds % 86_400) / 3_600);
    return `${days}d ${hours}h`;
  }
  const whole = Math.max(0, Math.floor(seconds));
  const h = Math.floor(whole / 3_600);
  const m = Math.floor((whole % 3_600) / 60);
  const s = whole % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

export interface FreerollCountdown {
  /** Ready to print: "0:00" when nothing is scheduled, never a word. */
  text: string;
  /** Inside the last ten seconds. */
  imminent: boolean;
  /** Tooltip: the name and wall-clock start, or that none is scheduled. */
  title: string;
  startsAt: number | null;
}

/**
 * The countdown itself: one database read a minute, one local tick a second,
 * and a re-read the moment a clock runs out, because the freeroll that just
 * started is no longer the next one.
 *
 * `override` is the test seam and the "I already know the time" path: pass a
 * number or null and no read is issued at all.
 */
export function useDiamondFreerollCountdown(override?: number | null): FreerollCountdown {
  const live = useNextDiamondFreeroll(override === undefined);
  const startsAt = override === undefined ? live.startsAt : override;

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startsAt == null) return;
    setNow(Date.now());
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(tick);
  }, [startsAt]);

  const remaining = startsAt == null ? null : Math.max(0, Math.floor((startsAt - now) / 1000));
  const expired = remaining === 0;
  const isLive = override === undefined;
  const { refresh } = live;
  useEffect(() => {
    if (expired && isLive) refresh();
  }, [expired, isLive, refresh]);

  return useMemo(
    () => ({
      startsAt,
      text: remaining == null ? '0:00' : formatFreerollCountdown(remaining),
      imminent: remaining != null && remaining > 0 && remaining <= FREEROLL_IMMINENT_SECONDS,
      title:
        startsAt == null
          ? 'No Freeroll Scheduled Yet'
          : `${live.name ?? 'Freeroll'} Starts ${new Date(startsAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`,
    }),
    [live.name, remaining, startsAt]
  );
}
