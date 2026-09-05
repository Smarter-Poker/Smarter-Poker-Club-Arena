/**
 * RIVER SQUEEZE 2026-09-04 — the board, rendered for real (happy-dom), driven
 * street by street the way TablePage drives it. Proves the river gets the
 * two-surface squeeze markup with the resolved profile's timing, the all-in
 * turn does too, a duplicate snapshot does not replay it, the undealt slots
 * keep their geometry, and a new hand interrupts a squeeze in flight.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import React from 'react';

vi.mock('../../src/services/SoundService', () => {
  const noop = () => {};
  const soundService = new Proxy({ isEnabled: () => true } as Record<string, unknown>, {
    get: (t, p: string) => (p in t ? t[p] : noop),
  });
  const haptic = new Proxy({} as Record<string, unknown>, { get: () => noop });
  return { soundService, haptic, default: soundService };
});

import { CommunityCards } from '../../src/components/table/CommunityCards';
import {
  cardPresentationEngine,
  CARD_PRESENTATION_PROFILES,
  flipMs,
} from '../../src/presentation/cardPresentation';
import { HAND_COMPLETION } from '../../src/config/handCompletionSpec';

const BOARD = [
  { rank: '4' as const, suit: 'd' as const },
  { rank: '7' as const, suit: 's' as const },
  { rank: 'A' as const, suit: 's' as const },
  { rank: 'T' as const, suit: 'd' as const },
  { rank: '7' as const, suit: 'c' as const },
];

let hand = 0;
const props = (over: Partial<React.ComponentProps<typeof CommunityCards>> = {}) => ({
  tableId: 'table-rs',
  handId: hand,
  ...over,
});

function riverCard(container: HTMLElement) {
  return container.querySelector<HTMLElement>('.community-cards__card--river');
}

describe('river squeeze on the board', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    hand += 1;
    cardPresentationEngine.forgetTable('table-rs');
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('the river materialises face down on the two-surface flip with the cash profile', () => {
    const { container, rerender } = render(
      <CommunityCards {...props()} cards={BOARD.slice(0, 4)} stage="turn" />
    );
    act(() => {
      rerender(<CommunityCards {...props()} cards={BOARD} stage="river" />);
    });
    const card = riverCard(container)!;
    expect(card).toBeTruthy();
    expect(card.classList.contains('community-cards__card--squeeze')).toBe(true);
    // two real surfaces: a back and a face
    expect(card.querySelector('.community-cards__flip')).toBeTruthy();
    expect(card.querySelector('.community-cards__flip-face--back .card-back')).toBeTruthy();
    expect(card.querySelector('.community-cards__flip-face--front')).toBeTruthy();
    // timing is the resolved profile, passed to the stylesheet inline
    const p = CARD_PRESENTATION_PROFILES.cashDesktop;
    expect(card.style.getPropertyValue('--rs-prepare')).toBe(`${p.prepareMs}ms`);
    expect(card.style.getPropertyValue('--rs-hold')).toBe(`${p.holdMs}ms`);
    expect(card.style.getPropertyValue('--rs-flip')).toBe(`${flipMs(p)}ms`);
    expect(card.style.getPropertyValue('--rs-overshoot')).toBe(String(p.overshoot));
    expect(card.dataset.rsProfile).toBe('cash-desktop');
    // the old one-sided spin is not on it
    expect(card.className).not.toMatch(/card--turn|slow-reveal/);
  });

  it('the temporary markup is torn down after the window; the face stays', () => {
    const { container, rerender } = render(
      <CommunityCards {...props()} cards={BOARD.slice(0, 4)} stage="turn" />
    );
    act(() => {
      rerender(<CommunityCards {...props()} cards={BOARD} stage="river" />);
    });
    expect(container.querySelector('.community-cards__card--squeeze')).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(container.querySelector('.community-cards__card--squeeze')).toBeNull();
    expect(container.querySelector('.community-cards__flip')).toBeNull();
    expect(container.querySelectorAll('.community-cards__card')).toHaveLength(5);
  });

  it('a duplicate river snapshot does not animate twice (spec 15)', () => {
    const { container, rerender } = render(
      <CommunityCards {...props()} cards={BOARD.slice(0, 4)} stage="turn" />
    );
    act(() => {
      rerender(<CommunityCards {...props()} cards={BOARD} stage="river" />);
    });
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    // The same hand re-delivers the same river (a re-sync). Simulate the
    // board seeing it as "new" again by cycling through turn.
    act(() => {
      rerender(<CommunityCards {...props()} cards={BOARD.slice(0, 4)} stage="turn" />);
    });
    act(() => {
      rerender(<CommunityCards {...props()} cards={BOARD} stage="river" />);
    });
    expect(container.querySelector('.community-cards__card--squeeze')).toBeNull();
    // and the board is still correct: five faces
    expect(container.querySelectorAll('.community-cards__card')).toHaveLength(5);
  });

  it('the all-in turn AND river squeeze with the all-in profile, sized to the server gate', () => {
    const { container, rerender } = render(
      <CommunityCards {...props()} cards={BOARD.slice(0, 3)} stage="flop" slowReveal />
    );
    act(() => {
      rerender(<CommunityCards {...props()} cards={BOARD.slice(0, 4)} stage="turn" slowReveal />);
    });
    const turn = container.querySelector<HTMLElement>('.community-cards__card--squeeze')!;
    expect(turn).toBeTruthy();
    expect(turn.dataset.rsProfile).toBe('all-in');
    const p = CARD_PRESENTATION_PROFILES.allIn;
    expect(turn.style.getPropertyValue('--rs-hold')).toBe(`${p.holdMs}ms`);
    expect(p.durationMs).toBe(HAND_COMPLETION.ALL_IN_STREET_REVEAL_MS);
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    act(() => {
      rerender(<CommunityCards {...props()} cards={BOARD} stage="river" slowReveal />);
    });
    expect(riverCard(container)!.dataset.rsProfile).toBe('all-in');
  });

  it('a background (unfocused) table gets the compact profile, a hidden one none', () => {
    const a = render(
      <CommunityCards {...props({ isFocused: false })} cards={BOARD.slice(0, 4)} stage="turn" />
    );
    act(() => {
      a.rerender(<CommunityCards {...props({ isFocused: false })} cards={BOARD} stage="river" />);
    });
    expect(riverCard(a.container)!.dataset.rsProfile).toBe('background');
    expect(riverCard(a.container)!.dataset.rsSweep).toBe('off');
    a.unmount();

    hand += 1;
    const b = render(
      <CommunityCards {...props({ isVisible: false })} cards={BOARD.slice(0, 4)} stage="turn" />
    );
    act(() => {
      b.rerender(<CommunityCards {...props({ isVisible: false })} cards={BOARD} stage="river" />);
    });
    expect(b.container.querySelector('.community-cards__card--squeeze')).toBeNull();
    expect(b.container.querySelectorAll('.community-cards__card')).toHaveLength(5);
  });

  it('a tournament board resolves the tournament profile', () => {
    const { container, rerender } = render(
      <CommunityCards
        {...props({ gameMode: 'tournament' })}
        cards={BOARD.slice(0, 4)}
        stage="turn"
      />
    );
    act(() => {
      rerender(
        <CommunityCards {...props({ gameMode: 'tournament' })} cards={BOARD} stage="river" />
      );
    });
    expect(riverCard(container)!.dataset.rsProfile).toBe('tournament-desktop');
  });

  it('boards 2 and 3 of a bomb pot stagger behind board 1 (spec 33)', () => {
    const p = CARD_PRESENTATION_PROFILES.cashDesktop;
    const boards = [0, 1, 2].map((boardIndex) =>
      render(<CommunityCards {...props({ boardIndex })} cards={BOARD.slice(0, 4)} stage="turn" />)
    );
    boards.forEach((b, boardIndex) => {
      act(() => {
        b.rerender(<CommunityCards {...props({ boardIndex })} cards={BOARD} stage="river" />);
      });
      const card = riverCard(b.container)!;
      expect(card.classList.contains('community-cards__card--squeeze')).toBe(true);
      expect(card.style.getPropertyValue('--rs-stagger')).toBe(`${boardIndex * p.staggerMs}ms`);
    });
  });

  it('undealt slots keep their geometry and draw nothing (spec 11)', () => {
    const { container, rerender } = render(
      <CommunityCards {...props()} cards={[]} stage="preflop" />
    );
    const row = container.querySelector('.community-cards__container')!;
    expect(row.children).toHaveLength(5);
    expect(container.querySelectorAll('.community-cards__slot-reserve')).toHaveLength(5);
    expect(container.querySelector('.community-cards__placeholder')).toBeNull();
    act(() => {
      rerender(<CommunityCards {...props()} cards={BOARD.slice(0, 3)} stage="flop" />);
    });
    expect(row.children).toHaveLength(5);
    expect(container.querySelectorAll('.community-cards__slot-reserve')).toHaveLength(2);
    for (const r of Array.from(container.querySelectorAll('.community-cards__slot-reserve'))) {
      expect(r.getAttribute('aria-hidden')).toBe('true');
      expect(r.textContent).toBe('');
    }
  });

  it('a new hand interrupts a squeeze in flight and the new board is authoritative', () => {
    const { container, rerender } = render(
      <CommunityCards {...props()} cards={BOARD.slice(0, 4)} stage="turn" />
    );
    act(() => {
      rerender(<CommunityCards {...props()} cards={BOARD} stage="river" />);
    });
    expect(container.querySelector('.community-cards__card--squeeze')).toBeTruthy();
    hand += 1;
    act(() => {
      rerender(<CommunityCards {...props()} cards={BOARD.slice(0, 3)} stage="flop" />);
    });
    expect(container.querySelector('.community-cards__card--squeeze')).toBeNull();
    expect(container.querySelectorAll('.community-cards__card--flop-deal')).toHaveLength(3);
    expect(cardPresentationEngine.activeCount).toBe(0);
  });

  it('without a table id, two boards on one page never share a lane (sim page)', () => {
    const a = render(<CommunityCards cards={BOARD.slice(0, 4)} stage="turn" />);
    const b = render(<CommunityCards cards={BOARD.slice(0, 4)} stage="turn" />);
    act(() => {
      a.rerender(<CommunityCards cards={BOARD} stage="river" />);
      b.rerender(<CommunityCards cards={BOARD} stage="river" />);
    });
    expect(riverCard(a.container)!.classList.contains('community-cards__card--squeeze')).toBe(true);
    expect(riverCard(b.container)!.classList.contains('community-cards__card--squeeze')).toBe(true);
  });

  it('the accessible label carries the river whether or not it animated (spec 50)', () => {
    const { container, rerender } = render(
      <CommunityCards {...props()} cards={BOARD.slice(0, 4)} stage="turn" />
    );
    act(() => {
      rerender(<CommunityCards {...props()} cards={BOARD} stage="river" />);
    });
    expect(container.querySelector('[role="region"]')!.getAttribute('aria-label')).toContain(
      '7 of c'
    );
  });
});
