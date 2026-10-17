import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { CommunityCards } from '../../src/components/table/CommunityCards';
import { cardPresentationEngine } from '../../src/presentation/cardPresentation';

const board = [
  { rank: '4', suit: 'd' },
  { rank: '7', suit: 's' },
  { rank: 'A', suit: 's' },
  { rank: 'T', suit: 'd' },
  { rank: '7', suit: 'c' },
] as const;
let hand = 0;
beforeEach(() => {
  vi.useFakeTimers();
  hand++;
  cardPresentationEngine.forgetTable('award-river');
});
afterEach(() => vi.useRealTimers());

describe('multi-run winner presentation follows the actual river', () => {
  for (const runs of [2, 3])
    it(`${runs} runs never name or highlight a winner over a face-down river`, async () => {
      const presented = vi.fn();
      const shared = {
        tableId: 'award-river',
        handId: hand,
        runs,
        winningHandName: 'Three Of A Kind',
        highlightedIndices: [1, 4],
        onRiverPresented: presented,
        playSounds: false,
      };
      const view = render(
        <CommunityCards {...shared} cards={[...board.slice(0, 4)]} stage="turn" />
      );
      expect(view.container.querySelector('.community-cards__hand-name')).toBeNull();
      expect(presented).not.toHaveBeenCalled();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      view.rerender(<CommunityCards {...shared} cards={[...board]} stage="river" />);
      expect(view.container.querySelector('.card-squeeze-host')).not.toBeNull();
      expect(view.container.querySelector('.community-cards__hand-name')).toBeNull();
      expect(presented).not.toHaveBeenCalled();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(presented).toHaveBeenCalledTimes(1);
      expect(view.container.querySelector('.community-cards__hand-name')?.textContent).toContain(
        'Three Of A Kind'
      );
    });
  it('an interrupted river is shown face up and releases its presentation once', async () => {
    const presented = vi.fn();
    const shared = {
      tableId: 'award-river',
      handId: hand,
      runs: 3,
      onRiverPresented: presented,
      playSounds: false,
    };
    const view = render(<CommunityCards {...shared} cards={[...board.slice(0, 4)]} stage="turn" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    view.rerender(<CommunityCards {...shared} cards={[...board]} stage="river" />);
    act(() => cardPresentationEngine.cancelAll('geometry-changed'));
    expect(view.container.querySelector('.card-squeeze-host')).toBeNull();
    expect(presented).toHaveBeenCalledTimes(1);
  });
});
