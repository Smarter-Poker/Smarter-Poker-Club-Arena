import { useState, useEffect, useCallback, useRef } from 'react';
import { soundService } from '../services/SoundService';
import { serverNow } from '../utils/serverClock';

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * useTableTimer Hook — SMOOTH countdown
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Uses requestAnimationFrame for fluid visual countdown instead of 1s ticks.
 * State updates are throttled to ~10fps to avoid excessive re-renders,
 * but the visual timer-progress is smooth because CSS transitions handle
 * the interpolation between state updates.
 */

export interface UseTableTimerProps {
  isActiveTurn: boolean;
  isHeroTurn: boolean;
  isSoundEnabled: boolean;
  onTimeout: () => void;
  initialTime?: number;
  urgencyThreshold?: number;
  /**
   * 2026-04-14 Bible V8 §6.1 — server-authoritative absolute deadline (ms
   * since epoch). When this changes, the hook resets its countdown so the
   * gold ring around the active seat shrinks from 100% → 0% on every turn,
   * not just the first one. The prior implementation used the local
   * initialTime once and never reset, so after the first expiry the ring
   * was permanently at 0% for the rest of the session.
   */
  turnDeadlineMs?: number;
  /**
   * When a new turn opens (currentPlayerSeat changes to a non-zero value)
   * the hook recomputes timeRemaining from this prop so every active seat
   * — horse or human — gets a visible disappearing ring.
   */
  activeSeatKey?: number | string;
}

export interface UseTableTimerReturn {
  timeRemaining: number;
  setTimeRemaining: (time: number) => void;
  resetTimer: (time?: number) => void;
  extendTimer: (extraSeconds: number) => void;
  isUrgent: boolean;
  timerProgress: number;
}

const DEFAULT_INITIAL_TIME = 15;
const DEFAULT_URGENCY_THRESHOLD = 5;

export function useTableTimer({
  isActiveTurn,
  isHeroTurn,
  isSoundEnabled,
  onTimeout,
  initialTime = DEFAULT_INITIAL_TIME,
  urgencyThreshold = DEFAULT_URGENCY_THRESHOLD,
  turnDeadlineMs,
  activeSeatKey,
}: UseTableTimerProps): UseTableTimerReturn {
  const [timeRemaining, setTimeRemaining] = useState(initialTime);
  const [totalTime, setTotalTime] = useState(initialTime);
  const onTimeoutRef = useRef(onTimeout);
  const timeRef = useRef(initialTime);
  const lastFrameRef = useRef<number | null>(null);
  const lastStateUpdateRef = useRef(0);
  onTimeoutRef.current = onTimeout;

  // Bible V8 §6.1 deadline-driven reset. Whenever the server emits a new
  // turn_change (which bumps turnDeadlineMs and activeSeatKey), reseed the
  // countdown so the ring starts full again.
  // 2026-04-14 BUG-2b: removed `isActiveTurn` from the dep array. Snapshots
  // arrive every ~150ms and briefly flap `isActiveTurn` false→true, which
  // was tearing down the RAF (see tick effect below) before the first frame
  // could decrement timeRef. Net effect: ring stuck at ~14.98s forever. We
  // now reseed only when the AUTHORITATIVE turn changes.
  useEffect(() => {
    let seconds = initialTime;
    if (turnDeadlineMs && turnDeadlineMs > 0) {
      // AUDIT FIX 2026-07-19: when we have an authoritative deadline that has
      // ALREADY passed (e.g. reconnecting/resyncing onto an expired turn), seed
      // 0 — NOT a fresh full timer. The old fallback reset an expired turn to
      // initialTime, which could re-fire onTimeout (double time-bank / auto-fold)
      // and disagreed with the CSS ring (which correctly lands at 0).
      // Dan 2026-08-20 (round 3, "the countdown literally only took 6
      // seconds"): this line subtracted a SERVER deadline from the DEVICE
      // clock. A device running N seconds fast starts every 15s turn with
      // (15 - N) seconds on the clock — Dan's timed 6s is exactly a ~9s-fast
      // device clock. The seat ring (SeatSlot) was already fixed to measure
      // on the engine's clock via serverNow(); this hook, which drives the
      // NUMERIC countdown, the footer seconds, the urgency window and the
      // time-bank/auto-fold trigger, was still on Date.now(). Same clock for
      // both from now on.
      seconds = Math.max(0, (turnDeadlineMs - serverNow()) / 1000);
    }
    setTotalTime(seconds);
    setTimeRemaining(seconds);
    timeRef.current = seconds;
    lastFrameRef.current = null;
    lastStateUpdateRef.current = 0;
  }, [turnDeadlineMs, activeSeatKey, initialTime]);

  const isUrgent = isHeroTurn && timeRemaining <= urgencyThreshold && timeRemaining > 0;

  const timerProgress =
    totalTime > 0 ? Math.max(0, Math.min(100, (timeRemaining / totalTime) * 100)) : 0;

  const resetTimer = useCallback(
    (newTime?: number) => {
      const t = newTime ?? initialTime;
      setTotalTime(t);
      setTimeRemaining(t);
      timeRef.current = t;
      lastFrameRef.current = null;
    },
    [initialTime]
  );

  const extendTimer = useCallback((extraSeconds: number) => {
    setTimeRemaining((prev) => {
      const newRemaining = prev + extraSeconds;
      setTotalTime(newRemaining);
      timeRef.current = newRemaining;
      lastFrameRef.current = null;
      return newRemaining;
    });
  }, []);

  // 2026-04-14 BUG-2b: Smooth RAF countdown that subscribes ONCE for the
  // lifetime of the hook. Prior version had `isActiveTurn` + `isHeroTurn` in
  // the dep array, which re-mounted the effect every time those bools
  // flapped (every ~150ms on snapshot broadcasts). Each remount re-seeded
  // `lastFrameRef=null` which made the first tick bail (it just caches
  // `now`), and the effect tore down again before the second tick could
  // run. Result: timer stuck at initialTime − one frame (~14.98s).
  //
  // New behavior: RAF runs forever. The reset effect above reseeds
  // timeRef whenever the server publishes a new turn deadline. When the
  // timer hits zero and we're the hero, the timeout callback fires ONCE
  // per turn — we gate the firing via a ref to avoid double-trigger.
  const heroFiredRef = useRef<number | null>(null);
  const isHeroTurnRef = useRef(isHeroTurn);
  isHeroTurnRef.current = isHeroTurn;
  /**
   * The RAF loop below subscribes ONCE (empty dep array) and must therefore read
   * every changing value through a ref. `turnDeadlineMs` was read as a prop from
   * inside that closure, which froze it at its MOUNT value - and the initial
   * table state has no `actionTimerDeadline`, so the frozen value is `undefined`.
   *
   * That broke the fired-once latch in a way that looks fine until you follow the
   * types: the guard compared `heroFiredRef.current !== undefined` while the
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

  useEffect(() => {
    // Reset the hero-timeout-fired guard when the deadline changes (new turn).
    heroFiredRef.current = null;
  }, [turnDeadlineMs, activeSeatKey]);

  useEffect(() => {
    let rafId: number;
    let cancelled = false;

    const tick = (now: number) => {
      if (cancelled) return;

      if (lastFrameRef.current === null) {
        lastFrameRef.current = now;
        rafId = requestAnimationFrame(tick);
        return;
      }

      const delta = (now - lastFrameRef.current) / 1000;
      lastFrameRef.current = now;

      timeRef.current = Math.max(0, timeRef.current - delta);

      if (timeRef.current <= 0) {
        // Read through the ref, not the frozen prop. `?? 0` on BOTH sides so the
        // value compared is the value stored - the old code compared against
        // `undefined` and stored `0`, which can never be equal.
        const deadlineNow = turnDeadlineRef.current ?? 0;
        if (isHeroTurnRef.current && heroFiredRef.current !== deadlineNow) {
          heroFiredRef.current = deadlineNow;
          onTimeoutRef.current();
        }
        // Hold at zero until the next reset — do NOT tear down the loop,
        // so the very next deadline change re-starts the countdown.
        setTimeRemaining(0);
        rafId = requestAnimationFrame(tick);
        return;
      }

      if (now - lastStateUpdateRef.current > 33) {
        lastStateUpdateRef.current = now;
        setTimeRemaining(timeRef.current);
      }

      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
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
  // TablePage is now the SOLE owner of the warning loop: it alone knows
  // whether it is the hero's turn, whether this table is the active one in
  // multi-table (#175), and the authoritative seconds remaining. This hook
  // still exposes `isUrgent` for visual urgency styling.

  return {
    timeRemaining,
    setTimeRemaining,
    resetTimer,
    extendTimer,
    isUrgent,
    timerProgress,
  };
}
