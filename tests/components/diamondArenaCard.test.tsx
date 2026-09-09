/**
 * THE DIAMOND ARENA IS A CLUB CARD, WITH A CLOCK ON IT.
 *
 * Dan, 2026-09-09: "THE DIAMOND ARENA CARD HAS TO LOOK AND FEEL EXACTLY LIKE
 * THE CLUB ARENA CARDS DO, SAME SQUARE SHAPE, ON THE BOTTOM HAVE AN ACTIVE
 * PLAYERS TAB, AND NEXT FREE ROLL STARTS IN X:XX TIMER." And, on review:
 * "IT SHOULDN'T SAY AUTOMATIC ENTRY ANYWHERE."
 *
 * The card used to be a 2:3 poster dropped into the carousel between two
 * four-zone club cards. These pins keep it on the club chassis, keep the two
 * figures on its rail, keep the countdown honest, and keep the words Dan
 * struck off it.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import DiamondArenaCard, {
  formatFreerollCountdown,
} from '../../src/components/club/DiamondArenaCard';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('formatFreerollCountdown', () => {
  it('prints M:SS under an hour, H:MM:SS under a day, days beyond', () => {
    expect(formatFreerollCountdown(42 * 60 + 17)).toBe('42:17');
    expect(formatFreerollCountdown(5)).toBe('0:05');
    expect(formatFreerollCountdown(3 * 3600 + 5 * 60 + 9)).toBe('3:05:09');
    expect(formatFreerollCountdown(2 * 86400 + 4 * 3600 + 30)).toBe('2d 4h');
    expect(formatFreerollCountdown(0)).toBe('0:00');
  });
});

describe('DiamondArenaCard', () => {
  it('is the club card chassis: four zones, two figures on the rail', () => {
    const { container } = render(
      <DiamondArenaCard
        activePlayers={1284}
        nextFreerollAt={Date.now() + 42 * 60 * 1000 + 17_500}
      />
    );
    expect(container.querySelector('.club-card-panel.club-card-panel--arena')).not.toBeNull();
    expect(container.querySelector('.club-card-id-plate')).not.toBeNull();
    expect(container.querySelector('.club-card-viewport img')).not.toBeNull();
    expect(container.querySelector('.club-card-name-plate')?.textContent).toBe('DIAMOND ARENA');
    expect(container.querySelectorAll('.club-card-stats-row .club-card-stat')).toHaveLength(2);
    expect(screen.getByText('ACTIVE PLAYERS')).toBeTruthy();
    expect(screen.getByText('NEXT FREEROLL')).toBeTruthy();
    expect(screen.getByText('1,284')).toBeTruthy();
    expect(screen.getByRole('timer').textContent).toBe('42:17');
  });

  it('never says Automatic Entry anywhere on the card', () => {
    const { container } = render(<DiamondArenaCard activePlayers={0} nextFreerollAt={null} />);
    expect(container.innerHTML.toLowerCase()).not.toContain('automatic entry');
  });

  it('prints zeros, never a word, when no freeroll is scheduled yet', () => {
    render(<DiamondArenaCard activePlayers={null} nextFreerollAt={null} />);
    expect(screen.getByRole('timer').textContent).toBe('0:00');
  });

  it('ticks down once a second and turns red inside the last ten seconds', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-10T00:00:00Z'));
    const { container } = render(
      <DiamondArenaCard activePlayers={3} nextFreerollAt={Date.now() + 12_000} />
    );
    expect(screen.getByRole('timer').textContent).toBe('0:12');
    expect(container.querySelector('.club-card-stat--imminent')).toBeNull();
    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    expect(screen.getByRole('timer').textContent).toBe('0:09');
    expect(container.querySelector('.club-card-stat--imminent')).not.toBeNull();
  });
});
