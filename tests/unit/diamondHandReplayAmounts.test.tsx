import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { buildReplay, replayInputFromRow } from '../../src/utils/handReplay';
import HandDetailView from '../../src/components/handdetail/HandDetailView';
import HandReplay from '../../src/components/replay/HandReplay';
vi.mock('../../src/hooks/useAuthUser', () => ({ useAuthUser: () => ({ user: null }) }));
vi.mock('../../src/services/SoundService', () => ({
  soundService: new Proxy({}, { get: () => vi.fn() }),
  haptic: new Proxy({}, { get: () => vi.fn() }),
}));
afterEach(cleanup);
function hand(arenaAsset?: 'chips' | 'diamonds') {
  return {
    ...buildReplay(
      replayInputFromRow({
        hand_number: 77,
        game_variant: 'nlh',
        small_blind: 1,
        big_blind: 2,
        pot_size: 20,
        players: [
          { userId: 'a', username: 'Alice', seat: 1, stack: 110, cards: [] },
          { userId: 'b', username: 'Bob', seat: 2, stack: 90, cards: [] },
        ],
        actions: [
          { seat: 1, userId: 'a', action: 'raise', amount: 10, stage: 'preflop' },
          { seat: 2, userId: 'b', action: 'call', amount: 8, stage: 'preflop' },
        ],
        winners: [{ userId: 'a', amount: 20, potIndex: 0 }],
      })
    ),
    arenaAsset,
  };
}
describe('actual hand amounts follow the authoritative arena through detail and replay', () => {
  it.each(['diamonds', 'chips', undefined] as const)(
    'renders %s amounts in the real rundown',
    (asset) => {
      const { container } = render(<HandDetailView model={hand(asset)} />);
      const amounts = [...container.querySelectorAll('.hdv__amt,.hdv__street-pot,.hdv__stack')]
        .map((n) => n.textContent)
        .filter(Boolean);
      expect(amounts.length).toBeGreaterThan(2);
      for (const amount of amounts) {
        if (asset === 'diamonds') expect(amount).not.toContain('.');
        else expect(amount).toMatch(/\.\d{2}$/);
      }
    }
  );
  it.each(['diamonds', 'chips', undefined] as const)(
    'renders %s amounts on the real replay felt',
    (asset) => {
      const { container } = render(
        <HandReplay source={{ model: hand(asset), tableName: 'Arena', handNumber: 77 }} />
      );
      expect(container.querySelector('.hr-felt__pot-value')?.textContent).toBe(
        asset === 'diamonds' ? '0' : '0.00'
      );
    }
  );
});
