import { act, cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import SeatSlot, { type SeatPlayer } from '../../src/components/table/SeatSlot';

const hero: SeatPlayer = {
  id: 'hero',
  name: 'Hero',
  stack: 299,
  status: 'active',
  isHero: true,
  holeCards: [
    { rank: '7', suit: 's' },
    { rank: '5', suit: 'c' },
  ],
};
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
it('a next-hand action cannot leave the live hero cards in the prior fold animation', () => {
  vi.useFakeTimers();
  const seat = (lastAction: 'fold' | null) => (
    <SeatSlot
      seatNumber={1}
      player={hero}
      position={null}
      isActive={false}
      lastAction={lastAction}
    />
  );
  const { container, rerender } = render(seat(null));
  rerender(seat('fold'));
  expect(
    container.querySelector('.seat__cards--hero')?.classList.contains('seat__cards--folding')
  ).toBe(true);
  act(() => vi.advanceTimersByTime(100));
  rerender(seat(null));
  act(() => vi.advanceTimersByTime(1000));
  expect(
    container.querySelector('.seat__cards--hero')?.classList.contains('seat__cards--folding')
  ).toBe(false);
  expect(container.querySelectorAll('.seat__cards--hero .seat__card')).toHaveLength(2);
});
