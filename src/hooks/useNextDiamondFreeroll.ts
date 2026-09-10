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
import { useCallback, useEffect, useState } from 'react';
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
