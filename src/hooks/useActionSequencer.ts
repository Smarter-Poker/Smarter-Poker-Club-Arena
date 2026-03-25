/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  useActionSequencer — Sequential Animation Pipeline (Bible V8 §5.2)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Bible V8 §5.2 Animation Sequence (MUST be sequential, NOT simultaneous):
 *   1. Action label appears (200ms)
 *   2. Chip animation fires (300ms)
 *   3. Pot total updates (100ms)
 *   4. Turn indicator moves (200ms)
 *
 * This hook provides a queueable animation sequencer that TablePage uses
 * to coordinate action feedback in the correct order.
 */

import { useCallback, useRef } from 'react';

export interface ActionSequenceStep {
  /** Step identifier for debugging */
  name: string;
  /** Duration to wait before proceeding to next step (ms) */
  durationMs: number;
  /** Callback to execute when this step fires */
  execute: () => void;
}

/**
 * Returns a function that runs a sequence of animation steps with prescribed delays.
 * Each step fires its execute() callback, waits its durationMs, then proceeds.
 * If a new sequence is triggered while one is running, the old one is cancelled.
 */
export function useActionSequencer() {
  const cancelRef = useRef<(() => void) | null>(null);

  const runSequence = useCallback((steps: ActionSequenceStep[]) => {
    // Cancel any in-flight sequence
    if (cancelRef.current) {
      cancelRef.current();
      cancelRef.current = null;
    }

    let cancelled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];

    cancelRef.current = () => {
      cancelled = true;
      timers.forEach(clearTimeout);
    };

    let cumulativeDelay = 0;

    for (const step of steps) {
      const delay = cumulativeDelay;
      const timer = setTimeout(() => {
        if (!cancelled) {
          step.execute();
        }
      }, delay);
      timers.push(timer);
      cumulativeDelay += step.durationMs;
    }
  }, []);

  const cancelSequence = useCallback(() => {
    if (cancelRef.current) {
      cancelRef.current();
      cancelRef.current = null;
    }
  }, []);

  return { runSequence, cancelSequence };
}

/**
 * Pre-built Bible V8 §5.2 action sequence timings (ms).
 * Consumers pass callbacks; this fills in the standard durations.
 */
export const BIBLE_V8_ACTION_TIMING = {
  ACTION_LABEL_MS: 200,
  CHIP_ANIMATION_MS: 300,
  POT_UPDATE_MS: 100,
  TURN_INDICATOR_MS: 200,
} as const;

/**
 * Convenience: build a standard 4-step action sequence per Bible V8 §5.2.
 */
export function buildActionSequence(callbacks: {
  showActionLabel: () => void;
  fireChipAnimation: () => void;
  updatePot: () => void;
  moveTurnIndicator: () => void;
}): ActionSequenceStep[] {
  return [
    {
      name: 'action-label',
      durationMs: BIBLE_V8_ACTION_TIMING.ACTION_LABEL_MS,
      execute: callbacks.showActionLabel,
    },
    {
      name: 'chip-animation',
      durationMs: BIBLE_V8_ACTION_TIMING.CHIP_ANIMATION_MS,
      execute: callbacks.fireChipAnimation,
    },
    {
      name: 'pot-update',
      durationMs: BIBLE_V8_ACTION_TIMING.POT_UPDATE_MS,
      execute: callbacks.updatePot,
    },
    {
      name: 'turn-indicator',
      durationMs: BIBLE_V8_ACTION_TIMING.TURN_INDICATOR_MS,
      execute: callbacks.moveTurnIndicator,
    },
  ];
}
