/**
 * useHeldValue - a value that stops updating while `hold` is true.
 *
 * VIP ALL-IN SQUEEZE 2026-09-05. While a player's squeezed card is still face
 * down under their hand, the equity overlay they see must keep showing the
 * previous street's numbers, however many fresher values arrive underneath.
 * The moment the hold lifts, the newest value shows.
 *
 * Deliberately a render-time ref write rather than an effect: an effect would
 * paint one frame of the live value before the hold caught up, and one frame
 * of the river's 100% is the whole spoiler.
 */
import { useRef } from 'react';

export function useHeldValue<T>(value: T, hold: boolean): T {
  const held = useRef(value);
  if (!hold) held.current = value;
  return held.current;
}
