import { afterEach, describe, expect, it } from 'vitest';
import { PreciseActionTimer } from './PreciseActionTimer.js';
import { TimeBankEngine, type TimeBankEvent } from './TimeBankEngine.js';

describe('ordinary Lifetime sessions after an explicit historical loss', () => {
  const timers: PreciseActionTimer[] = [];
  afterEach(() => {
    for (const timer of timers.splice(0)) timer.dispose();
  });

  it('preserves every usable activation of the actual 120-second witness under the same guards', () => {
    const exercise = (remainingSeconds: number, usesRemaining: number, unlimited: boolean) => {
      const timer = new PreciseActionTimer();
      timers.push(timer);
      const events: TimeBankEvent[] = [];
      const bank = new TimeBankEngine(timer, (event) => events.push(event));
      bank.configure('table', { secondsPerUse: 20, refillPerOrbit: false });
      bank.initializePlayer('table', 'user', {
        remainingSeconds,
        usesRemaining,
        unlimitedActivations: unlimited,
      });
      const granted: number[] = [];
      for (let street = 0; street < 4; street++) {
        bank.resetStreetActivations('table');
        const before = { ...bank.getPlayerBank('table', 'user') };
        // A depleted finite bank may refuse before reaching the clock guard.
        expect(bank.tryActivate('table', 'user', () => {}, 1)).not.toBe('activated');
        expect(bank.getPlayerBank('table', 'user')).toEqual(before);
        let seconds = 0;
        for (let use = 0; use < 2; use++) {
          const outcome = bank.tryActivate('table', 'user', () => {}, 0);
          if (outcome === 'activated') {
            expect(bank.tryActivate('table', 'user', () => {}, 0)).toBe('already_active');
            expect(events.at(-1)?.secondsGranted).toBe(20);
            seconds += Number(events.at(-1)?.secondsGranted);
            bank.playerActed('table', 'user');
          } else expect(outcome).toBe('depleted');
        }
        expect(bank.tryActivate('table', 'user', () => {}, 0)).not.toBe('activated');
        granted.push(seconds);
      }
      return granted;
    };
    const recordedFinite = exercise(120, 6, false);
    const currentLifetime = exercise(40, 2, true);
    expect(recordedFinite).toEqual([40, 40, 40, 0]);
    expect(currentLifetime).toEqual([40, 40, 40, 40]);
    expect(currentLifetime.every((seconds, index) => seconds >= recordedFinite[index])).toBe(true);
  });
});
