/**
 * HORSE PACING: the beat between something happening at the felt and a horse
 * reacting to it (Dan 2026-10-21: chat and throws must "be random and feel
 * genuine and not like a bot or ai player").
 *
 * A person sees the pot pushed, reads the cards, then types or taps. A
 * reaction on the same frame as the event is the tell. The beat is a hash of
 * the reaction's own key, so it is spread across the range, never one number,
 * and a replay waits the same time.
 *
 * Pacing only: nothing here retries, repeats or schedules work for later.
 */

import { personaHash } from '../engine/HorsePersona.js';

export type BeatKind = 'typed' | 'tap' | 'quick';

/** [min, max) milliseconds for each kind of reaction. */
const RANGES: Record<BeatKind, [number, number]> = {
  /** Owner 2026-10-27: never type post-hand chat before five seconds. */
  typed: [5_000, 10_000],
  /** a throwable after a hand: open the seat menu, pick, send */
  tap: [900, 3_600],
  /** a line or a throw as the horse moves in: already in motion */
  quick: [150, 900],
};

export function humanBeatMs(key: string, kind: BeatKind): number {
  const [lo, hi] = RANGES[kind];
  return lo + (personaHash(`${key}|beat`) % (hi - lo));
}

let pacingOn = true;

/** Test hook: a suite on fake timers turns the beat off rather than advancing clocks. */
export function _setHumanPacingForTests(on: boolean): void {
  pacingOn = on;
}

export function humanBeat(ms: number): Promise<void> {
  if (!pacingOn || !(ms > 0)) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}
