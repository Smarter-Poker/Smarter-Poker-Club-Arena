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
}: UseTableTimerProps): UseTableTimerReturn {
  const [timeRemaining, setTimeRemaining] = useState(initialTime);
  const [totalTime, setTotalTime] = useState(initialTime);
  const onTimeoutRef = useRef(onTimeout);
  const timeRef = useRef(initialTime);
  const lastFrameRef = useRef<number | null>(null);
  const lastStateUpdateRef = useRef(0);
  onTimeoutRef.current = onTimeout;

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

  // Smooth countdown via requestAnimationFrame, state updates throttled to ~10fps
  useEffect(() => {
    if (!isActiveTurn) {
      lastFrameRef.current = null;
      return;
    }

    let rafId: number;
    let timedOut = false;

    const tick = (now: number) => {
      if (timedOut) return;

      if (lastFrameRef.current === null) {
        lastFrameRef.current = now;
        rafId = requestAnimationFrame(tick);
        return;
      }

      const delta = (now - lastFrameRef.current) / 1000;
      lastFrameRef.current = now;

      timeRef.current = Math.max(0, timeRef.current - delta);

      if (timeRef.current <= 0) {
        timedOut = true;
        setTimeRemaining(0);
        if (isHeroTurn) {
          onTimeoutRef.current();
        }
        return;
      }

      // Throttle React state updates to every ~33ms (~30fps) for smooth visual
      if (now - lastStateUpdateRef.current > 33) {
        lastStateUpdateRef.current = now;
        setTimeRemaining(timeRef.current);
      }

      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(rafId);
      timedOut = true;
    };
  }, [isActiveTurn, isHeroTurn]);

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
