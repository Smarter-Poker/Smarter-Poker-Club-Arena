import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import SeatSlot, { type SeatPlayer } from '../../src/components/table/SeatSlot';

const player: SeatPlayer = {
  id: 'folding-player',
  name: 'Folding Player',
  stack: 100,
  avatar: '/avatars/table/free_shark.webp',
  status: 'active',
  isHero: false,
  showCards: false,
};
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function seat(foldCommitted: boolean, lastAction: 'fold' | null = null, isHero = false) {
  return (
    <SeatSlot
      seatNumber={1}
      player={{ ...player, isHero }}
      position={null}
      isActive={false}
      lastAction={lastAction}
      lastBetAmount={10}
      foldCommitted={foldCommitted}
    />
  );
}

describe('the real seat hides identity only after the committed fold', () => {
  it('keeps a queued or optimistic fold visible until the engine accepts it', () => {
    const { container } = render(seat(false, 'fold'));
    expect(container.querySelector('.seat--fold-hidden')).toBeNull();
    expect(container.querySelector('.seat__avatar-wrap')?.hasAttribute('inert')).toBe(false);
  });

  it.each([false, true])(
    'updates the mounted seat and restores it next hand (hero=%s)',
    (isHero) => {
      const { container, rerender } = render(seat(false, null, isHero));
      rerender(seat(true, null, isHero));
      expect(container.querySelector('.seat--fold-hidden')).not.toBeNull();
      expect(container.querySelector('.seat__avatar-wrap')?.hasAttribute('inert')).toBe(true);
      expect(container.querySelector('.seat__info')?.getAttribute('aria-hidden')).toBe('true');
      expect(container.querySelector('.seat--empty')).toBeNull();
      expect(container.querySelector('.seat__wager-group')).not.toBeNull();
      rerender(seat(false, null, isHero));
      expect(container.querySelector('.seat--fold-hidden')).toBeNull();
      expect(container.querySelector('.seat__avatar-wrap')?.hasAttribute('inert')).toBe(false);
    }
  );

  it('finishes the existing fold motion before hiding the avatar and plate', () => {
    vi.useFakeTimers();
    const { container, rerender } = render(seat(false));
    rerender(seat(true, 'fold'));
    expect(container.querySelector('.seat--fold-hidden')).toBeNull();
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(container.querySelector('.seat--fold-hidden')).not.toBeNull();
    expect(container.querySelector('.seat__wager-group')).not.toBeNull();
  });
});
