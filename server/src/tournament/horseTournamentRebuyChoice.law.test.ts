import { describe, expect, it } from 'vitest';
import { horseChoosesTournamentRebuy } from './horseTournamentRebuyChoice.js';

describe('horses choose a tournament rebuy on 45 percent of busts', () => {
  it('keeps the same decision across repeated reads and rejects unknown busts', () => {
    for (const hand of [null, undefined, 0, -1, NaN, Infinity, 1.5]) {
      expect(horseChoosesTournamentRebuy('event', 'horse', hand)).toBe(false);
    }
    const first = horseChoosesTournamentRebuy('event', 'horse', 123);
    for (let i = 0; i < 10; i++) {
      expect(horseChoosesTournamentRebuy('event', 'horse', 123)).toBe(first);
    }
  });

  it('varies by horse, event and bust, with approximately 45 percent choosing yes', () => {
    for (const vary of ['horse', 'event', 'hand']) {
      let yes = 0;
      for (let i = 1; i <= 10_000; i++) {
        yes += Number(
          horseChoosesTournamentRebuy(
            vary === 'event' ? `event-${i}` : 'event',
            vary === 'horse' ? `horse-${i}` : 'horse',
            vary === 'hand' ? i : 123
          )
        );
      }
      expect(yes).toBeGreaterThan(4300);
      expect(yes).toBeLessThan(4700);
    }
  });
});
