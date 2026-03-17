import { useState, useEffect, useCallback, useRef } from 'react';
import { soundService } from '../services/SoundService';

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * useTableTimer Hook
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Manages poker table action timer with countdown logic, auto-fold, and warnings.
 * Handles:
 * - Countdown interval management
 * - Auto-fold when timer reaches 0
 * - Timer urgency state (< 5 seconds)
 * - Progress percentage calculation
 * - Timer warning sounds
 * - Automatic cleanup on unmount
 */

export interface UseTableTimerProps {
  isActiveTurn: boolean; // is ANYONE acting? (runs visual ticking)
  isHeroTurn: boolean; // is HERO acting? (triggers auto-fold)
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
  isUrgent: boolean; // true when < urgencyThreshold seconds
  timerProgress: number; // 0-100 percentage
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
  onTimeoutRef.current = onTimeout;

  const isUrgent = isHeroTurn && timeRemaining <= urgencyThreshold && timeRemaining > 0;

  // Calculate progress as percentage (0-100) based on TOTAL current time allowance
  const timerProgress = Math.max(0, Math.min(100, (timeRemaining / totalTime) * 100));

  // Reset timer to initial time or custom time
  const resetTimer = useCallback(
    (newTime?: number) => {
      const t = newTime ?? initialTime;
      setTotalTime(t);
      setTimeRemaining(t);
    },
    [initialTime]
  );

  // Extend the timer (e.g. Time Bank activation)
  const extendTimer = useCallback((extraSeconds: number) => {
    setTimeRemaining((prev) => {
      const newRemaining = prev + extraSeconds;
      setTotalTime(newRemaining); // Recalculate full circle from the new extended baseline
      return newRemaining;
    });
  }, []);

  // Timer countdown — ticks whenever ANYONE is acting
  useEffect(() => {
    if (!isActiveTurn) return;

    const interval = setInterval(() => {
      setTimeRemaining((prev) => {
        if (prev <= 0) return 0;
        const newValue = prev - 1;
        if (newValue <= 0) {
          if (isHeroTurn) {
            onTimeoutRef.current();
          }
          return 0;
        }
        return newValue;
      });
    }, 1000);

    return () => clearInterval(interval);
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
