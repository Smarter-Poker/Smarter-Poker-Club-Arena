import { describe, expect, it, vi } from 'vitest';
import { TournamentSweepWorkCursor } from './TournamentSweepWorkCursor.js';

describe('TournamentSweepWorkCursor', () => {
  it('keeps successful 5.1-second stages and eventually reaches every tail stage', async () => {
    vi.useFakeTimers();
    try {
      const cursor = new TournamentSweepWorkCursor();
      const executed: number[] = [];

      // Model ten scheduler admissions whose one successful request takes
      // longer than the five-second cooperative budget. Each response is
      // accepted, the cursor advances, and only the *next* request yields.
      for (let admission = 0; admission < 10; admission++) {
        const stage = cursor.nextStage;
        await vi.advanceTimersByTimeAsync(5_100);
        executed.push(stage);
        cursor.advanceTo(stage + 1);
      }

      expect(executed).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
      expect(cursor.nextStage).toBe(10);
      cursor.reset();
      expect(cursor.nextStage).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never moves backwards when an older continuation finishes late', () => {
    const cursor = new TournamentSweepWorkCursor();
    cursor.advanceTo(7);
    cursor.advanceTo(3);
    expect(cursor.nextStage).toBe(7);
  });
});
