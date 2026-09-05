/**
 * RIVER SQUEEZE 2026-09-04 / ROUND 2 2026-09-05 — the board, rendered for
 * real (happy-dom), driven street by street the way TablePage drives it.
 * Proves the turn and the river both get the shared two-surface squeeze with
 * the resolved profile's timing, that the snap lands on the reveal beat and
 * not on the street transition, that a duplicate snapshot does not replay it,
 * that the undealt slots keep their geometry, and that a new hand interrupts
 * a squeeze in flight.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import React from 'react';

const played: string[] = [];
vi.mock('../../src/services/SoundService', () => {
  const make =
    (name: string) =>
    (...a: unknown[]) => {
      played.push(name);
      void a;
    };
  const soundService = new Proxy({ isEnabled: () => true } as Record<string, unknown>, {
    get: (t, p: string) => (p in t ? t[p] : make(p)),
  });
  const haptic = new Proxy({} as Record<string, unknown>, {
    get: (_t, p: string) => make(`haptic.${p}`),
  });
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

const squeezing = (c: HTMLElement) => c.querySelector<HTMLElement>('.card-squeeze-host');
const riverCard = (c: HTMLElement) => c.querySelector<HTMLElement>('.community-cards__card--river');
const turnCard = (c: HTMLElement) => c.querySelector<HTMLElement>('.community-cards__card--turn');

describe('the squeeze on the board', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    hand += 1;
    played.length = 0;
    cardPresentationEngine.forgetTable('table-rs');
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('the river materialises face down on the shared two-surface card, cash profile', () => {
    const { container, rerender } = render(
      <CommunityCards {...props()} cards={BOARD.slice(0, 4)} stage="turn" />
    );
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    act(() => {
      rerender(<CommunityCards {...props()} cards={BOARD} stage="river" />);
    });
    const card = riverCard(container)!;
    expect(card).toBeTruthy();
    expect(card.classList.contains('card-squeeze-host')).toBe(true);
    // two real surfaces, plus the spine and the shadow layer
    expect(card.querySelector('.card-squeeze')).toBeTruthy();
    expect(card.querySelector('.card-squeeze__face--back .card-back')).toBeTruthy();
    expect(card.querySelector('.card-squeeze__face--front')).toBeTruthy();
    expect(card.querySelector('.card-squeeze__spine')).toBeTruthy();
    expect(card.querySelector('.card-squeeze__shadow')).toBeTruthy();
    // timing is the resolved profile, passed to the stylesheet inline
    const p = CARD_PRESENTATION_PROFILES.cashDesktop;
    expect(card.style.getPropertyValue('--rs-prepare')).toBe(`${p.prepareMs}ms`);
    expect(card.style.getPropertyValue('--rs-hold')).toBe(`${p.holdMs}ms`);
    expect(card.style.getPropertyValue('--rs-flip')).toBe(`${flipMs(p)}ms`);
    expect(card.style.getPropertyValue('--rs-overshoot')).toBe(String(p.overshoot));
    expect(card.dataset.rsProfile).toBe('cash-desktop');
  });

  it('the TURN squeezes too, on an ordinary hand (spec 123: one visual language)', () => {
    const { container, rerender } = render(
      <CommunityCards {...props()} cards={BOARD.slice(0, 3)} stage="flop" />
    );
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    act(() => {
      rerender(<CommunityCards {...props()} cards={BOARD.slice(0, 4)} stage="turn" />);
    });
    const card = turnCard(container)!;
    expect(card).toBeTruthy();
    expect(card.classList.contains('card-squeeze-host')).toBe(true);
    expect(card.dataset.rsProfile).toBe('cash-desktop');
    expect(card.querySelector('.card-squeeze__face--back .card-back')).toBeTruthy();
  });

  it('the snap lands on the REVEAL beat, not on the street transition', () => {
    const p = CARD_PRESENTATION_PROFILES.cashDesktop;
    const { rerender } = render(
      <CommunityCards {...props()} cards={BOARD.slice(0, 4)} stage="turn" />
    );
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    played.length = 0;
    act(() => {
      rerender(<CommunityCards {...props()} cards={BOARD} stage="river" />);
    });
    // The street has arrived and the card is still FACE DOWN: silence.
    expect(played).not.toContain('playCommunityCard');
    // Just before the surfaces swap: still silent.
    act(() => {
      vi.advanceTimersByTime(p.prepareMs + p.holdMs + p.squeezeMs - 5);
    });
    expect(played).not.toContain('playCommunityCard');
    // The face appears; the snap lands with it.
    act(() => {
      vi.advanceTimersByTime(10);
    });
    expect(played).toContain('playCommunityCard');
    expect(played).toContain('haptic.medium');
    // and exactly once
    expect(played.filter((p2) => p2 === 'playCommunityCard')).toHaveLength(1);
  });

  it('an all-in river holds face down for the server gate, and the snap waits with it', () => {
    const p = CARD_PRESENTATION_PROFILES.allIn;
    expect(p.durationMs).toBe(HAND_COMPLETION.ALL_IN_STREET_REVEAL_MS);
    const { container, rerender } = render(
      <CommunityCards {...props()} cards={BOARD.slice(0, 4)} stage="turn" slowReveal />
    );
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    played.length = 0;
    act(() => {
      rerender(<CommunityCards {...props()} cards={BOARD} stage="river" slowReveal />);
    });
    expect(riverCard(container)!.dataset.rsProfile).toBe('all-in');
    expect(riverCard(container)!.style.getPropertyValue('--rs-hold')).toBe(`${p.holdMs}ms`);
    // A full second of hold, and no sound yet — the card is still face down.
    act(() => {
      vi.advanceTimersByTime(p.prepareMs + p.holdMs - 5);
    });
    expect(played).not.toContain('playCommunityCard');
    act(() => {
      vi.advanceTimersByTime(p.squeezeMs + 10);
    });
    expect(played).toContain('playCommunityCard');
  });

  it('with no squeeze in flight the cue is paid on the spot, never dropped (10.6)', () => {
    // A hidden table: the engine returns `instant`, so there is no reveal beat
    // to wait for and the sound must not be swallowed.
    const { container, rerender } = render(
      <CommunityCards {...props({ isVisible: false })} cards={BOARD.slice(0, 4)} stage="turn" />
    );
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    played.length = 0;
    act(() => {
      rerender(<CommunityCards {...props({ isVisible: false })} cards={BOARD} stage="river" />);
    });
    expect(container.querySelector('.card-squeeze-host')).toBeNull();
    expect(played).toContain('playCommunityCard');
  });

  it('the temporary markup is torn down after the window; the face stays', () => {
    const { container, rerender } = render(
      <CommunityCards {...props()} cards={BOARD.slice(0, 4)} stage="turn" />
    );
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    act(() => {
      rerender(<CommunityCards {...props()} cards={BOARD} stage="river" />);
    });
    expect(squeezing(container)).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(squeezing(container)).toBeNull();
    expect(container.querySelector('.card-squeeze')).toBeNull();
    expect(container.querySelectorAll('.community-cards__card')).toHaveLength(5);
  });

  it('a duplicate river snapshot does not animate twice (spec 15)', () => {
    const { container, rerender } = render(
      <CommunityCards {...props()} cards={BOARD.slice(0, 4)} stage="turn" />
    );
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    act(() => {
      rerender(<CommunityCards {...props()} cards={BOARD} stage="river" />);
    });
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    // The same hand re-delivers the same river (a re-sync).
    act(() => {
      rerender(<CommunityCards {...props()} cards={BOARD.slice(0, 4)} stage="turn" />);
    });
    act(() => {
      rerender(<CommunityCards {...props()} cards={BOARD} stage="river" />);
    });
    expect(squeezing(container)).toBeNull();
    expect(container.querySelectorAll('.community-cards__card')).toHaveLength(5);
  });

  it('a background (unfocused) table gets the compact profile, a hidden one none', () => {
    const a = render(
      <CommunityCards {...props({ isFocused: false })} cards={BOARD.slice(0, 4)} stage="turn" />
    );
    act(() => {
      vi.advanceTimersByTime(2000);
    });
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
      vi.advanceTimersByTime(2000);
    });
    act(() => {
      b.rerender(<CommunityCards {...props({ isVisible: false })} cards={BOARD} stage="river" />);
    });
    expect(b.container.querySelector('.card-squeeze-host')).toBeNull();
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
      vi.advanceTimersByTime(2000);
    });
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
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    boards.forEach((b, boardIndex) => {
      act(() => {
        b.rerender(<CommunityCards {...props({ boardIndex })} cards={BOARD} stage="river" />);
      });
      const card = riverCard(b.container)!;
      expect(card.classList.contains('card-squeeze-host')).toBe(true);
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
      vi.advanceTimersByTime(2000);
    });
    act(() => {
      rerender(<CommunityCards {...props()} cards={BOARD} stage="river" />);
    });
    expect(squeezing(container)).toBeTruthy();
    hand += 1;
    act(() => {
      rerender(<CommunityCards {...props()} cards={BOARD.slice(0, 3)} stage="flop" />);
    });
    expect(squeezing(container)).toBeNull();
    expect(container.querySelectorAll('.community-cards__card--flop-deal')).toHaveLength(3);
    expect(cardPresentationEngine.activeCount).toBe(0);
  });

  it('the flop keeps its own three-card fan, not the squeeze', () => {
    const { container, rerender } = render(
      <CommunityCards {...props()} cards={[]} stage="preflop" />
    );
    act(() => {
      rerender(<CommunityCards {...props()} cards={BOARD.slice(0, 3)} stage="flop" />);
    });
    expect(container.querySelectorAll('.community-cards__flip')).toHaveLength(3);
    expect(container.querySelector('.card-squeeze-host')).toBeNull();
  });

  it('without a table id, two boards on one page never share a lane (sim page)', () => {
    const a = render(<CommunityCards cards={BOARD.slice(0, 4)} stage="turn" />);
    const b = render(<CommunityCards cards={BOARD.slice(0, 4)} stage="turn" />);
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    act(() => {
      a.rerender(<CommunityCards cards={BOARD} stage="river" />);
      b.rerender(<CommunityCards cards={BOARD} stage="river" />);
    });
    expect(riverCard(a.container)!.classList.contains('card-squeeze-host')).toBe(true);
    expect(riverCard(b.container)!.classList.contains('card-squeeze-host')).toBe(true);
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
