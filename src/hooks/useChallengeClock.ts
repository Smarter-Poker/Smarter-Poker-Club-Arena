import { useSyncExternalStore } from 'react';

/**
 * One wall-clock publisher for every Daily Missions countdown leaf.
 *
 * The previous page kept `Date.now()` in DailyChallengesPage state. Even at its
 * reduced cadence that made the hero, command deck, vault, tabs, every mission
 * card, and the celebration tree reconcile just to change countdown text. This
 * store keeps time completely outside the page container: only a component
 * that calls useChallengeClockNow re-renders when the whole second changes.
 *
 * Readings are derived from Date.now(), never by subtracting one second, so a
 * throttled/background tab catches up immediately instead of displaying drift.
 */
export class ChallengeClockStore {
  private snapshot = Date.now();
  private readonly listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  readonly getSnapshot = (): number => this.snapshot;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    if (this.listeners.size === 1) this.start();

    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.stop();
    };
  };

  private readonly publish = (): void => {
    const next = Date.now();
    if (Math.floor(next / 1000) !== Math.floor(this.snapshot / 1000)) {
      this.snapshot = next;
      for (const listener of Array.from(this.listeners)) listener();
    }
  };

  private readonly schedule = (): void => {
    if (this.listeners.size === 0) return;
    // Align just after the next wall-clock second. The small margin avoids a
    // browser waking a fraction early and publishing the same whole second.
    const delay = 1000 - (Date.now() % 1000) + 16;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.publish();
      this.schedule();
    }, delay);
  };

  private readonly handleVisibility = (): void => {
    if (document.visibilityState === 'visible') this.publish();
  };

  private start(): void {
    this.snapshot = Date.now();
    document.addEventListener('visibilitychange', this.handleVisibility);
    this.schedule();
  }

  private stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    document.removeEventListener('visibilitychange', this.handleVisibility);
  }

  /** Test/diagnostic seam. */
  get listenerCount(): number {
    return this.listeners.size;
  }
}

export const challengeClock = new ChallengeClockStore();

/** Wall-clock milliseconds for countdown leaves; never page-container state. */
export function useChallengeClockNow(): number {
  return useSyncExternalStore(
    challengeClock.subscribe,
    challengeClock.getSnapshot,
    challengeClock.getSnapshot
  );
}
