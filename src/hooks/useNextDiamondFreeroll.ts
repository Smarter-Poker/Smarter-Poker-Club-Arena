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
 *
 * THE ANSWER HAS FOUR SHAPES, AND THREE OF THEM ARE NOT A CLOCK (2026-09-19).
 * Until today "no freeroll scheduled" and "the read has not answered yet" and
 * "the read failed" all collapsed into `startsAt: null`, and every consumer
 * printed that as `0:00`, which on a countdown means "starting now". With no
 * Diamond freeroll on the calendar, every player who opened the arena lobby
 * read a freeroll starting this second. So the hook now says which of the
 * four it is, and the countdown below prints a word for each of the three
 * that are not a time.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';
import { DIAMOND_ARENA_CLUB_ID } from '../lib/constants';
import { reportError } from '../utils/errorReporter';

export const DIAMOND_FREEROLL_POLL_MS = 60_000;

/**
 * What the hook knows about the next freeroll.
 *
 *   loading    the first read has not answered
 *   scheduled  a freeroll exists and `startsAt` is its start
 *   none       the read answered and there is no freeroll ahead
 *   error      the read failed, so nothing is known either way
 */
export type FreerollClockState = 'loading' | 'scheduled' | 'none' | 'error';

export interface NextDiamondFreeroll {
  /** Epoch ms of the next freeroll's start, or null when none is scheduled. */
  startsAt: number | null;
  /** Its name, for the tooltip. */
  name: string | null;
  /** True once the first read has answered, right or wrong. */
  resolved: boolean;
  /** Which of the four answers this is; `startsAt` is non-null only when scheduled. */
  state: FreerollClockState;
  /** Ask again now (the card calls this when its countdown hits zero). */
  refresh: () => void;
}

export function useNextDiamondFreeroll(enabled = true): NextDiamondFreeroll {
  const [startsAt, setStartsAt] = useState<number | null>(null);
  const [name, setName] = useState<string | null>(null);
  const [state, setState] = useState<FreerollClockState>('loading');
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
        /* A failed read is an unknown, never a zero and never a "none": the
           last known clock is dropped rather than left ticking on a figure
           nothing is confirming. */
        setStartsAt(null);
        setName(null);
        setState('error');
        return;
      }
      const ms = data?.start_time ? Date.parse(data.start_time) : NaN;
      if (Number.isFinite(ms)) {
        setStartsAt(ms);
        setName(data?.name ?? null);
        setState('scheduled');
      } else {
        setStartsAt(null);
        setName(null);
        setState('none');
      }
    };

    void read();
    const poll = window.setInterval(() => void read(), DIAMOND_FREEROLL_POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(poll);
    };
  }, [enabled, nonce]);

  return { startsAt, name, resolved: state !== 'loading', state, refresh };
}

export default useNextDiamondFreeroll;

/** Inside this many seconds the clock is about to matter; the surface reddens. */
export const FREEROLL_IMMINENT_SECONDS = 10;

/** What the rail prints when the read answered and no freeroll is ahead. */
export const FREEROLL_NONE_TEXT = 'None Scheduled';
/** What the rail prints when the read failed: an honest unknown, never a zero. */
export const FREEROLL_UNKNOWN_TEXT = 'Unavailable';
/** Zeros until the read lands, the same rule every figure on a club card follows
 *  (Dan 2026-09-02: "zeros until the card loads"). */
export const FREEROLL_LOADING_TEXT = '0:00';

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

/**
 * The text a freeroll rail prints for a state that is not a running clock.
 * Returns null for `scheduled`, because that one is a countdown and the
 * caller owns the seconds.
 */
export function freerollClockWord(state: FreerollClockState): string | null {
  switch (state) {
    case 'none':
      return FREEROLL_NONE_TEXT;
    case 'error':
      return FREEROLL_UNKNOWN_TEXT;
    case 'loading':
      return FREEROLL_LOADING_TEXT;
    default:
      return null;
  }
}

/** The tooltip for each shape of answer. */
export function freerollClockTitle(
  state: FreerollClockState,
  startsAt: number | null,
  name: string | null
): string {
  if (state === 'scheduled' && startsAt != null)
    return `${name ?? 'Freeroll'} Starts ${new Date(startsAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  if (state === 'error') return 'Could Not Read The Freeroll Schedule';
  if (state === 'loading') return 'Reading The Freeroll Schedule';
  return 'No Freeroll Scheduled Yet';
}

export interface FreerollCountdown {
  /** Ready to print: a countdown when one is scheduled, otherwise a word for
   *  the state ("None Scheduled", "Unavailable"), never a zero for nothing. */
  text: string;
  /** Inside the last ten seconds. */
  imminent: boolean;
  /** Tooltip: the name and wall-clock start, or why there is no clock. */
  title: string;
  startsAt: number | null;
  /** Which shape of answer `text` is printing. */
  state: FreerollClockState;
}

/**
 * The countdown itself: one database read a minute, one local tick a second,
 * and a re-read the moment a clock runs out, because the freeroll that just
 * started is no longer the next one.
 *
 * `override` is the test seam and the "I already know the time" path: pass a
 * number (scheduled) or null (none) and no read is issued at all.
 */
export function useDiamondFreerollCountdown(override?: number | null): FreerollCountdown {
  const live = useNextDiamondFreeroll(override === undefined);
  const startsAt = override === undefined ? live.startsAt : override;
  const state: FreerollClockState =
    override === undefined ? live.state : override === null ? 'none' : 'scheduled';

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
      state,
      text:
        remaining == null
          ? (freerollClockWord(state) ?? FREEROLL_LOADING_TEXT)
          : formatFreerollCountdown(remaining),
      imminent: remaining != null && remaining > 0 && remaining <= FREEROLL_IMMINENT_SECONDS,
      title: freerollClockTitle(state, startsAt, live.name),
    }),
    [live.name, remaining, startsAt, state]
  );
}
