import { useState, useEffect, useCallback, useRef } from 'react';
import { soundService } from '../services/SoundService';

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
      seconds = Math.max(0, (turnDeadlineMs - Date.now()) / 1000);
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
        if (isHeroTurnRef.current && heroFiredRef.current !== turnDeadlineMs) {
          heroFiredRef.current = turnDeadlineMs ?? 0;
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

  // Timer warning sound
  useEffect(() => {
    if (isUrgent && isSoundEnabled) {
      soundService.startTimerWarning();
    } else {
      soundService.stopTimerWarning();
    }
    return () => soundService.stopTimerWarning();
  }, [isUrgent, isSoundEnabled]);

  return {
    timeRemaining,
    setTimeRemaining,
    resetTimer,
    extendTimer,
    isUrgent,
    timerProgress,
  };
}
