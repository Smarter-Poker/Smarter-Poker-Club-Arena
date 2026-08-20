/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  useAnimationQueue — one celebration at a time, and none of them skipped
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * ANIMATION AUDIT 2026-08-20.
 *
 * Dan's standing rule for this whole body of work: "NO ACTION FOR ANY HORSE OR
 * PLAYER CAN EVER BE SKIPPED OR RUSHED." The bounty overlays broke it on their
 * first day, in the exact shape everything else broke:
 *
 *   A three-way all-in busts TWO players. The engine processes eliminations
 *   one at a time, so it broadcasts `bounty_collected` twice, milliseconds
 *   apart. Both landed in a single `useState`, so the second overwrote the
 *   first — the first knockout's animation was replaced mid-flight and the
 *   player never saw it. Two heads taken, one celebration shown.
 *
 * This is the same "superseded in its own tick" class as the seven engine-side
 * fixes, just moved into React state. The answer is the same: give the first
 * one its airtime, then play the next.
 *
 * Deliberately NOT a set of concurrent overlays. Two knockout banners on screen
 * at once is noise, and the mystery chest is a takeover that cannot meaningfully
 * be shown twice over. Sequential is both simpler and better.
 *
 * The queue is unbounded by design: a bounty is money, and a player is owed the
 * sight of every one they collected. The realistic ceiling is the table size.
 */

import { useCallback, useRef, useState } from 'react';

export interface AnimationQueue<T> {
  /** The item currently being shown, or null when idle. */
  current: T | null;
  /** Add an item. Shows immediately if idle, otherwise waits its turn. */
  enqueue: (item: T) => void;
  /** The current item finished — advance to the next, if any. */
  complete: () => void;
  /** How many are still waiting behind `current`. Useful for a "+2 more" hint. */
  pending: number;
}

export function useAnimationQueue<T>(): AnimationQueue<T> {
  const [current, setCurrent] = useState<T | null>(null);
  const [pending, setPending] = useState(0);
  const queueRef = useRef<T[]>([]);
  // Mirrors `current` so enqueue can decide synchronously whether something is
  // already on screen. Reading the state variable inside the callback would see
  // a stale value when two broadcasts land in the same tick — which is the one
  // case this hook exists for.
  const busyRef = useRef(false);

  const enqueue = useCallback((item: T) => {
    if (!busyRef.current) {
      busyRef.current = true;
      setCurrent(item);
      return;
    }
    queueRef.current.push(item);
    setPending(queueRef.current.length);
  }, []);

  const complete = useCallback(() => {
    const next = queueRef.current.shift();
    setPending(queueRef.current.length);
    if (next === undefined) {
      busyRef.current = false;
      setCurrent(null);
      return;
    }
    // Clear first, then set on the next macrotask. Without the gap, a component
    // keyed on identity would see one continuous item and never restart its
    // entrance animation — the second knockout would inherit the first one's
    // mid-flight state instead of playing from the top.
    setCurrent(null);
    setTimeout(() => setCurrent(next), 0);
  }, []);

  return { current, enqueue, complete, pending };
}
