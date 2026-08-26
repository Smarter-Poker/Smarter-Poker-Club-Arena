import { useState, useEffect, useCallback, useRef } from 'react';
import { serverNow } from '../utils/serverClock';

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * useTableTimer — the action clock
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * ─── WHY THIS WAS REWRITTEN (2026-08-25, table audit) ────────────────────────
 *
 * TWO DEFECTS, ONE CAUSE. The countdown was INTEGRATED from requestAnimationFrame
 * deltas and pushed into React state every ~33ms:
 *
 *   1. PERFORMANCE. That state lives in TablePage, so the entire table component
 *      — every seat, every card, the pot, the chat panel — re-rendered about
 *      THIRTY TIMES A SECOND for the whole of anybody's turn, on a phone, during
 *      a live hand. It was the single most expensive thing on the page.
 *
 *   2. CORRECTNESS. requestAnimationFrame does not run in a hidden tab. Lock the
 *      phone or switch apps on your own turn and the integrated clock FROZE: no
 *      urgency, no time-bank request, no client-side auto-fold, until the tab
 *      woke up and one enormous frame delta landed at once. The seat ring
 *      (SeatSlot) never had this problem because it is a pure-CSS animation
 *      derived from the server's absolute deadline. The clock that actually
 *      decides whether to spend a time bank did.
 *
 * ─── WHAT IT DOES NOW ────────────────────────────────────────────────────────
 *
 * DERIVED, NOT INTEGRATED. There is one number of record: `deadlineRef`, an
 * absolute instant on the ENGINE's clock. Every evaluation is
 * `(deadline - serverNow()) / 1000`. That is the same expression SeatSlot's ring
 * is built from, so the numeral and the ring can no longer disagree, and it is
 * immune to dropped frames, throttling and a backgrounded tab. Nothing
 * accumulates, so nothing drifts.
 *
 * PUBLISHED ONCE A SECOND. React state changes only when the WHOLE second
 * changes. Every consumer of this hook either ceils the value or compares it to
 * a coarse threshold:
 *
 *   TablePage  `{Math.ceil(actionTimeRemaining)}s`     — whole seconds
 *   TablePage  `actionTimeRemaining <= 3 && > 0`       — whole-second boundary
 *   SeatSlot   `timerProgress <= 20` / `<= 33`         — colour class
 *   SeatSlot   `Math.ceil(secondsLeft)`                — whole seconds
 *
 * so NOT ONE of them can tell the difference, and the render count for a 15
 * second turn drops from roughly 450 to 15. The published `timerProgress` is
 * still computed from the PRECISE remainder at the instant of publication, not
 * from the rounded second, so the 20%/33% thresholds land where they always did
 * to within one publication.
 *
 * (The one place that wanted sub-second resolution is SeatSlot's legacy
 * `--timer-progress` fallback, which only renders when the engine has published
 * NO deadline at all. In that state there is no server timing to be smooth
 * about; it steps once a second now. The real ring is unaffected.)
 *
 * TWO DRIVERS. requestAnimationFrame while the tab is visible — it is free, it
 * is aligned to paint, and it keeps the last-second transition crisp — plus a
 * plain interval that keeps evaluating when RAF is asleep. Both call the same
 * `tick`, and the fired-once latch below makes a double call harmless.
 */

export interface UseTableTimerProps {
  /**
   * Is ANY seat on the clock right now. Read (finally — it was accepted and
   * ignored for months) as a guard on the hero timeout: a stale deadline left
   * over from the previous hand must never fire a time-bank request between
   * hands.
   */
  isActiveTurn: boolean;
  isHeroTurn: boolean;
  /**
   * @deprecated Accepted and ignored. The timer-warning sound has been owned
   * solely by TablePage since 2026-08-20 (two effects were fighting over one
   * singleton interval and stuttering the countdown). TablePage may stop
   * passing this at any time; nothing here reads it.
   */
  isSoundEnabled?: boolean;
  onTimeout: () => void;
  initialTime?: number;
  urgencyThreshold?: number;
  /**
   * 2026-04-14 Bible V8 §6.1 — server-authoritative absolute deadline (ms since
   * epoch, on the ENGINE's clock). This is the hook's number of record: when it
   * changes, the countdown is reseeded from it, and every evaluation in between
   * is derived from it rather than accumulated.
   */
  turnDeadlineMs?: number;
  /**
   * When a new turn opens (currentPlayerSeat changes to a non-zero value) the
   * hook recomputes from this prop so every active seat — horse or human — gets
   * a visible disappearing ring.
   */
  activeSeatKey?: number | string;
}

export interface UseTableTimerReturn {
  /**
   * WHOLE seconds remaining, rounded up: 15 for the whole of the first second,
   * 1 for the whole of the last, 0 at expiry. Changes at most once a second —
   * see the header. `setTimeRemaining` used to be returned beside it and was
   * called by nobody; it was also a trap, because it wrote display state that
   * the very next frame overwrote from the clock. It is gone.
   */
  timeRemaining: number;
  resetTimer: (time?: number) => void;
  extendTimer: (extraSeconds: number) => void;
  isUrgent: boolean;
  /** 0-100, computed from the precise remainder at the moment of publication. */
  timerProgress: number;
}

const DEFAULT_INITIAL_TIME = 15;
const DEFAULT_URGENCY_THRESHOLD = 5;

/**
 * How often the deadline is re-read. A countdown that publishes whole seconds
 * needs nothing finer than this, and on a 120Hz phone it cuts the arithmetic by
 * six without changing a single rendered value.
 */
const EVAL_INTERVAL_MS = 50;

/**
 * The background-safe driver. requestAnimationFrame stops in a hidden tab;
 * setInterval keeps running (throttled to about once a second, which is exactly
 * the resolution this clock publishes at anyway).
 */
const WATCHDOG_INTERVAL_MS = 500;

export function useTableTimer({
  isActiveTurn,
  isHeroTurn,
  onTimeout,
  initialTime = DEFAULT_INITIAL_TIME,
  urgencyThreshold = DEFAULT_URGENCY_THRESHOLD,
  turnDeadlineMs,
  activeSeatKey,
}: UseTableTimerProps): UseTableTimerReturn {
  /**
   * ONE piece of state, published at whole-second granularity. Seconds and
   * progress travel together so a publication is one render, not two.
   */
  const [clock, setClock] = useState(() => ({
    seconds: Math.ceil(Math.max(0, initialTime)),
    progress: initialTime > 0 ? 100 : 0,
  }));

  /** The instant the turn ends, on the ENGINE's clock. */
  const deadlineRef = useRef<number>(serverNow() + initialTime * 1000);
  /** Turn length, for `timerProgress`. A ref, not state: it is never rendered. */
  const totalTimeRef = useRef<number>(initialTime);
  /** The whole second most recently pushed into state. */
  const publishedSecondsRef = useRef<number>(Math.ceil(Math.max(0, initialTime)));

  const onTimeoutRef = useRef(onTimeout);
  onTimeoutRef.current = onTimeout;
  const isHeroTurnRef = useRef(isHeroTurn);
  isHeroTurnRef.current = isHeroTurn;
  const isActiveTurnRef = useRef(isActiveTurn);
  isActiveTurnRef.current = isActiveTurn;

  /**
   * The RAF loop below subscribes ONCE (empty dep array) and must therefore read
   * every changing value through a ref. `turnDeadlineMs` was once read as a prop
   * from inside that closure, which froze it at its MOUNT value - and the
   * initial table state has no `actionTimerDeadline`, so the frozen value is
   * `undefined`.
   *
   * That broke the fired-once latch in a way that looks fine until you follow
   * the types: the guard compared `heroFiredRef.current !== undefined` while the
   * assignment stored `undefined ?? 0`, i.e. `0`. `0 !== undefined` is always
   * true, so the latch never latched and `onTimeout` fired on EVERY FRAME once
   * the clock hit zero - roughly sixty times a second, each one opening the
   * time-bank sheet and firing a fresh activateTimeBank request at the engine.
   *
   * It was survivable only by accident: TablePage passed
   * `isHeroTurn: isHeroTurnContext && !timeBankActive`, so the first timeout set
   * timeBankActive and the next frame found isHeroTurnRef false. That `&&` was
   * removed on 2026-08-23 because it also blinded the hook for the whole of a
   * running bank (no second bank, no auto-fold fallback) - which took the brake
   * off this. Fixing the latch is the right half of that change.
   */
  const turnDeadlineRef = useRef(turnDeadlineMs);
  turnDeadlineRef.current = turnDeadlineMs;

  /**
   * Re-read the deadline and, ONLY if the whole second changed, render.
   * Returns the precise remainder either way, because the expiry check needs it
   * on every evaluation and not just on the ones that render.
   */
  const publish = useCallback((force = false): number => {
    const remaining = Math.max(0, (deadlineRef.current - serverNow()) / 1000);
    const whole = Math.ceil(remaining);
    if (!force && whole === publishedSecondsRef.current) return remaining;
    publishedSecondsRef.current = whole;
    const total = totalTimeRef.current;
    const progress = total > 0 ? Math.max(0, Math.min(100, (remaining / total) * 100)) : 0;
    setClock({ seconds: whole, progress });
    return remaining;
  }, []);

  // Bible V8 §6.1 deadline-driven reset. Whenever the server emits a new
  // turn_change (which bumps turnDeadlineMs and activeSeatKey), reseed.
  //
  // 2026-04-14 BUG-2b: `isActiveTurn` is deliberately NOT in this dep array.
  // Snapshots arrive every ~150ms and briefly flap it false->true; reseeding on
  // that would restart the countdown several times a second. We reseed only when
  // the AUTHORITATIVE turn changes.
  useEffect(() => {
    if (turnDeadlineMs && turnDeadlineMs > 0) {
      /* AUDIT FIX 2026-07-19: an authoritative deadline that has ALREADY passed
         (reconnecting onto an expired turn) seeds 0 by construction here — the
         derivation clamps at zero — NOT a fresh full timer. The old fallback
         reset an expired turn to initialTime, which could re-fire onTimeout
         (double time-bank / auto-fold) and disagreed with the CSS ring.

         Dan 2026-08-20 ("the countdown literally only took 6 seconds"): the
         remaining time is measured on the ENGINE's clock via serverNow(), not
         the device's. A device running N seconds fast used to start every 15s
         turn with (15 - N) seconds on it. */
      deadlineRef.current = turnDeadlineMs;
      totalTimeRef.current = Math.max(0, (turnDeadlineMs - serverNow()) / 1000);
    } else {
      totalTimeRef.current = initialTime;
      deadlineRef.current = serverNow() + initialTime * 1000;
    }
    publish(true);
  }, [turnDeadlineMs, activeSeatKey, initialTime, publish]);

  const isUrgent = isHeroTurn && clock.seconds <= urgencyThreshold && clock.seconds > 0;

  const resetTimer = useCallback(
    (newTime?: number) => {
      const t = Math.max(0, newTime ?? initialTime);
      /* Dan 2026-08-23, time bank: "it must RESET the clock for 20 more
         seconds." A new local deadline, not a nudge to a display value — so the
         next evaluation, wherever it comes from, agrees with it. The engine's
         own new deadline lands on the following snapshot and takes over through
         the effect above; until then this is the honest local answer. */
      deadlineRef.current = serverNow() + t * 1000;
      totalTimeRef.current = t;
      publish(true);
    },
    [initialTime, publish]
  );

  const extendTimer = useCallback(
    (extraSeconds: number) => {
      deadlineRef.current += extraSeconds * 1000;
      totalTimeRef.current += extraSeconds;
      publish(true);
    },
    [publish]
  );

  const heroFiredRef = useRef<number | null>(null);

  useEffect(() => {
    // Reset the hero-timeout-fired guard when the deadline changes (new turn).
    heroFiredRef.current = null;
  }, [turnDeadlineMs, activeSeatKey]);

  useEffect(() => {
    let rafId = 0;
    let watchdogId: ReturnType<typeof setInterval> | undefined;
    let cancelled = false;
    let lastEvalAt = -Infinity;

    const tick = (now: number) => {
      if (cancelled) return;
      /* `now` is whatever the caller had to hand — a RAF DOMHighResTimeStamp
         from one driver, nothing at all from the other. It is deliberately not
         used for timing: the two drivers do not share a time origin, and mixing
         a performance timestamp with an epoch one into the same throttle is how
         you get a loop that gates itself off permanently. The countdown is
         derived from an absolute deadline anyway, so the only job of the
         throttle is to stop a 120Hz display doing the arithmetic six times more
         often than it can possibly matter — and ONE clock does that for both
         drivers. */
      void now;
      const at = Date.now();
      // Two drivers call this; whichever gets here first inside the window wins
      // and the other does nothing.
      if (at - lastEvalAt < EVAL_INTERVAL_MS) return;
      lastEvalAt = at;

      const remaining = publish();
      if (remaining > 0) return;

      // Read through the ref, not the frozen prop. `?? 0` on BOTH sides so the
      // value compared is the value stored - the old code compared against
      // `undefined` and stored `0`, which can never be equal.
      const deadlineNow = turnDeadlineRef.current ?? 0;
      // isActiveTurn finally does something: a stale deadline from a finished
      // hand must not spend a time bank between hands.
      if (isActiveTurnRef.current && isHeroTurnRef.current && heroFiredRef.current !== deadlineNow) {
        heroFiredRef.current = deadlineNow;
        onTimeoutRef.current();
      }
      // Hold at zero until the next reset — do NOT tear down either driver, so
      // the very next deadline change re-starts the countdown.
    };

    const frame = (now: number) => {
      if (cancelled) return;
      tick(now);
      rafId = requestAnimationFrame(frame);
    };

    rafId = requestAnimationFrame(frame);
    // RAF is suspended in a hidden tab. This is what keeps the clock honest —
    // and keeps the time-bank request happening — while the phone is locked.
    watchdogId = setInterval(() => tick(0), WATCHDOG_INTERVAL_MS);

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
      if (watchdogId !== undefined) clearInterval(watchdogId);
    };
  }, []); // Subscribe once for the hook's lifetime.

  // Timer warning sound.
  //
  // AUDIT-2 FIX 2026-08-20: REMOVED. Two independent effects were driving the
  // same singleton warning interval — this one (on `isUrgent`) and TablePage's
  // (on the hero's turn + <=5s). They fought each other: each one's cleanup
  // called stopTimerWarning() on the other's interval, and startTimerWarning()
  // plays a tick immediately, so the two together stuttered the countdown and
  // could leave the loop running after the turn ended.
  //
  // TablePage is now the SOLE owner of the warning loop. This hook still
  // exposes `isUrgent` for visual urgency styling.

  return {
    timeRemaining: clock.seconds,
    resetTimer,
    extendTimer,
    isUrgent,
    timerProgress: clock.progress,
  };
}
