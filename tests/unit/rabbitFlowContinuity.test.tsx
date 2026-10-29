import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { CommunityCards } from '../../src/components/table/CommunityCards';
vi.mock('../../src/services/SoundService', () => ({
  haptic: { light: vi.fn(), medium: vi.fn(), strong: vi.fn() },
  soundService: { isEnabled: () => false },
}));
afterEach(cleanup);
const flop = [
  { rank: 'A', suit: 's' },
  { rank: 'K', suit: 'd' },
  { rank: '7', suit: 'c' },
] as any;
const rabbit = [
  { rank: '2', suit: 'h' },
  { rank: '9', suit: 's' },
] as any;
describe('Rabbit Hunt display continuity', () => {
  it('keeps the same card nodes and original slots when the next preflop begins', () => {
    const { container, rerender } = render(
      <CommunityCards
        cards={flop}
        stage="flop"
        rabbitCards={rabbit}
        playSounds={false}
        handId={41}
      />
    );
    const original = Array.from(container.querySelectorAll('.community-cards__card--rabbit'));
    expect(original).toHaveLength(2);
    expect(container.querySelector('.community-cards__container--rabbit-reveal')).toBeTruthy();
    rerender(
      <CommunityCards
        cards={[]}
        stage="preflop"
        rabbitCards={rabbit}
        rabbitStartIndex={3}
        playSounds={false}
        handId={42}
      />
    );
    const next = Array.from(container.querySelectorAll('.community-cards__card--rabbit'));
    expect(container.querySelector('.community-cards__container--rabbit-reveal')).toBeNull();
    expect(next[0]).toBe(original[0]);
    expect(next[1]).toBe(original[1]);
    expect(container.querySelectorAll('.community-cards__slot-reserve[style]')).toHaveLength(3);
  });
  it('fills an incomplete completed board even when its stage is showdown', () => {
    const { container, getByRole } = render(
      <CommunityCards cards={flop} stage="showdown" rabbitCards={rabbit} playSounds={false} />
    );
    expect(container.querySelectorAll('.community-cards__card--rabbit')).toHaveLength(2);
    expect(getByRole('status').textContent).toBe('Rabbit Hunt · Only You');
  });
  it('keeps preflop full runouts and turn runouts complete without drawing undealt placeholders', () => {
    const { container, rerender } = render(
      <CommunityCards
        cards={[]}
        stage="preflop"
        rabbitCards={[...flop, ...rabbit]}
        playSounds={false}
      />
    );
    expect(container.querySelectorAll('.community-cards__card--rabbit')).toHaveLength(5);
    rerender(
      <CommunityCards
        cards={[...flop, rabbit[0]]}
        stage="turn"
        rabbitCards={[rabbit[1]]}
        playSounds={false}
      />
    );
    expect(container.querySelectorAll('.community-cards__card--rabbit')).toHaveLength(1);
    rerender(<CommunityCards cards={flop} stage="flop" playSounds={false} />);
    expect(container.querySelectorAll('.community-cards__card--rabbit')).toHaveLength(0);
    expect(container.querySelectorAll('.community-cards__slot-reserve[style]')).toHaveLength(0);
  });
});
