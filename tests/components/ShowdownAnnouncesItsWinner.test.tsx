/**
 * Dan 2026-10-24: "PROPERLY DISPLAY AND ANNOUCE THE WINNING HANDS BETTER".
 * Rendered, not grepped: the board band carries WHO won above the hand, and a
 * seat names the hand it tabled, gold for the winner and muted for a beaten
 * hand that is still face up.
 */
import React from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { CommunityCards } from '../../src/components/table/CommunityCards';
import SeatSlot, { type SeatPlayer } from '../../src/components/table/SeatSlot';

afterEach(() => cleanup());

const board = [
  { rank: 'K', suit: 'h' },
  { rank: 'K', suit: 'd' },
  { rank: '9', suit: 's' },
  { rank: '9', suit: 'c' },
  { rank: '2', suit: 'h' },
];

describe('the board announces who won', () => {
  it('prints the winner line above the hand name, inside a live region', () => {
    const { container } = render(
      <CommunityCards
        tableId="announce"
        handId={1}
        cards={board as any}
        stage="showdown"
        winningHandName="Full House"
        winningHandDescription="Kings Full Of Nines"
        winningPlayerLabel="Danimal Wins"
        playSounds={false}
      />
    );
    const band = container.querySelector('.community-cards__hand-name');
    expect(band?.getAttribute('role')).toBe('status');
    expect(band?.getAttribute('aria-live')).toBe('polite');
    const line = band?.querySelector('.community-cards__winner-line');
    expect(line?.textContent).toBe('Danimal Wins');
    // The winner line comes first, the hand second, its description third.
    expect(band?.textContent).toBe('Danimal WinsFull HouseKings Full Of Nines');
  });

  it('prints no winner line when none is given', () => {
    const { container } = render(
      <CommunityCards
        tableId="announce-2"
        handId={2}
        cards={board as any}
        stage="showdown"
        winningHandName="Full House"
        playSounds={false}
      />
    );
    expect(container.querySelector('.community-cards__winner-line')).toBeNull();
    expect(container.querySelector('.community-cards__hand-name-text')?.textContent).toBe(
      'Full House'
    );
  });
});

const villain: SeatPlayer = {
  id: 'villain',
  name: 'Villain',
  stack: 0,
  avatar: '/avatars/table/free_shark.webp',
  status: 'all_in',
  isHero: false,
  showCards: true,
};

function seat(props: Partial<React.ComponentProps<typeof SeatSlot>>) {
  return (
    <SeatSlot
      seatNumber={3}
      player={villain}
      position={null}
      isActive={false}
      lastAction={null}
      lastBetAmount={0}
      {...props}
    />
  );
}

describe('every tabled hand names itself at its seat', () => {
  it('a beaten hand that is still face up shows its name, muted', () => {
    const { container } = render(seat({ shownHandName: 'two pair' }));
    const label = container.querySelector('.seat__hand-name--shown');
    expect(label?.textContent).toBe('Two Pair');
    expect(container.querySelector('.seat__hand-name--winner')).toBeNull();
  });

  it('the winner reads gold, once, and never alongside the shown name', () => {
    const { container } = render(
      seat({ isWinner: true, winningHandName: 'three of a kind', shownHandName: 'three of a kind' })
    );
    expect(container.querySelector('.seat__hand-name--winner')?.textContent).toBe(
      'Three Of A Kind'
    );
    expect(container.querySelector('.seat__hand-name--shown')).toBeNull();
  });

  it('says nothing once the hand is going to the muck, or was mucked', () => {
    const mucking = render(seat({ shownHandName: 'Pair', isMucking: true }));
    expect(mucking.container.querySelector('.seat__hand-name--shown')).toBeNull();
    cleanup();
    const mucked = render(seat({ shownHandName: 'Pair', isMuckedShowdown: true }));
    expect(mucked.container.querySelector('.seat__hand-name--shown')).toBeNull();
  });
});
