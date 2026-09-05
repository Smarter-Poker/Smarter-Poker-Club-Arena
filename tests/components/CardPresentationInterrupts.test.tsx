/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE INTERRUPTS, AT THE DOM (audit fix 2026-09-05)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every one of these was previously "covered" by a test that grepped the
 * component's SOURCE for a string, or that asserted on a hand-written stub
 * engine. Both kinds pass on a completely broken component, and both did:
 * `cancelAll` shipped to production cancelling the engine's bookkeeping while
 * the browser carried on running the flip, and no test noticed because no
 * test looked at the DOM after a cancel.
 *
 * These render the real board and assert what is actually on screen.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import React from 'react';

const played: string[] = [];
vi.mock('../../src/services/SoundService', () => {
  const make = (n: string) => () => {
    played.push(n);
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
} from '../../src/presentation/cardPresentation';

const BOARD = [
  { rank: '4' as const, suit: 'd' as const },
  { rank: '7' as const, suit: 's' as const },
  { rank: 'A' as const, suit: 's' as const },
  { rank: 'T' as const, suit: 'd' as const },
  { rank: '7' as const, suit: 'c' as const },
];

let hand = 0;
const props = (over: Partial<React.ComponentProps<typeof CommunityCards>> = {}) => ({
  tableId: 'table-int',
  handId: hand,
  ...over,
});
const squeezing = (c: HTMLElement) => c.querySelector('.card-squeeze-host');
const fanning = (c: HTMLElement) => c.querySelectorAll('.community-cards__card--flop-deal');

function toRiver(rerender: (ui: React.ReactElement) => void) {
  act(() => {
    rerender(<CommunityCards {...props()} cards={BOARD.slice(0, 4)} stage="turn" />);
  });
  act(() => {
    vi.advanceTimersByTime(3000);
  });
  played.length = 0;
  act(() => {
    rerender(<CommunityCards {...props()} cards={BOARD} stage="river" />);
  });
}

describe('a cancel reaches the pixels, not just the engine', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    hand += 1;
    played.length = 0;
    cardPresentationEngine.forgetTable('table-int');
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('cancelAll REMOVES the squeeze markup from the board', () => {
    const { container, rerender } = render(
      <CommunityCards {...props()} cards={BOARD.slice(0, 4)} stage="turn" />
    );
    toRiver(rerender);
    expect(squeezing(container), 'the river should be squeezing').toBeTruthy();

    // What a window resize does.
    act(() => {
      cardPresentationEngine.cancelAll('geometry-changed');
    });

    expect(squeezing(container), 'the flip markup must be gone').toBeNull();
    expect(container.querySelector('.card-squeeze')).toBeNull();
    // and the authoritative board is still correct: five faces
    expect(container.querySelectorAll('.community-cards__card')).toHaveLength(5);
  });

  it('the snap is paid AT the cancel, with the card now face up - never before it', () => {
    const p = CARD_PRESENTATION_PROFILES.allIn;
    const { container, rerender } = render(
      <CommunityCards {...props()} cards={BOARD.slice(0, 3)} stage="flop" slowReveal />
    );
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    act(() => {
      rerender(<CommunityCards {...props()} cards={BOARD.slice(0, 4)} stage="turn" slowReveal />);
    });
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    played.length = 0;
    act(() => {
      rerender(<CommunityCards {...props()} cards={BOARD} stage="river" slowReveal />);
    });
    // deep inside the face-down hold: silent, and still face down
    act(() => {
      vi.advanceTimersByTime(Math.round(p.prepareMs + p.holdMs / 2));
    });
    expect(played).not.toContain('playCommunityCard');
    expect(squeezing(container)).toBeTruthy();

    act(() => {
      cardPresentationEngine.cancelAll('backgrounded');
    });
    // the card is face up NOW, so the cue is correct now
    expect(squeezing(container)).toBeNull();
    expect(played).toContain('playCommunityCard');
    // and exactly once - it must not be paid again by the mount window
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(played.filter((x) => x === 'playCommunityCard')).toHaveLength(1);
  });

  it('a cancelled FLOP stops fanning too (its key is registered now)', () => {
    const { container, rerender } = render(
      <CommunityCards {...props()} cards={[]} stage="preflop" />
    );
    act(() => {
      rerender(<CommunityCards {...props()} cards={BOARD.slice(0, 3)} stage="flop" />);
    });
    expect(fanning(container)).toHaveLength(3);
    act(() => {
      cardPresentationEngine.cancelAll('geometry-changed');
    });
    expect(fanning(container)).toHaveLength(0);
    expect(container.querySelectorAll('.community-cards__card')).toHaveLength(3);
  });

  it('unmounting mid-FLOP leaves nothing in the engine', () => {
    const { rerender, unmount } = render(
      <CommunityCards {...props()} cards={[]} stage="preflop" />
    );
    act(() => {
      rerender(<CommunityCards {...props()} cards={BOARD.slice(0, 3)} stage="flop" />);
    });
    expect(cardPresentationEngine.activeCount).toBe(1);
    unmount();
    expect(cardPresentationEngine.activeCount).toBe(0);
  });

  it('a cancel on ANOTHER table does not disturb this one', () => {
    const { container, rerender } = render(
      <CommunityCards {...props()} cards={BOARD.slice(0, 4)} stage="turn" />
    );
    toRiver(rerender);
    expect(squeezing(container)).toBeTruthy();
    act(() => {
      cardPresentationEngine.cancelTable('some-other-table', 'unmount');
    });
    expect(squeezing(container)).toBeTruthy();
  });
});

describe('a table nobody can see does not animate (spec 47)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    hand += 1;
    cardPresentationEngine.forgetTable('table-int');
  });
  afterEach(() => vi.useRealTimers());

  it('an inactive multi-table slot renders the final board instantly', () => {
    const { container, rerender } = render(
      <CommunityCards {...props({ isVisible: false })} cards={BOARD.slice(0, 4)} stage="turn" />
    );
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    act(() => {
      rerender(<CommunityCards {...props({ isVisible: false })} cards={BOARD} stage="river" />);
    });
    expect(squeezing(container)).toBeNull();
    expect(container.querySelectorAll('.community-cards__card')).toHaveLength(5);
    expect(cardPresentationEngine.activeCount).toBe(0);
  });

  it('and TablePage actually passes it - the off profile is reachable in production', () => {
    // The one thing a render test here cannot prove. Four boards, four props.
    const fs = require('node:fs') as typeof import('node:fs');
    const path = require('node:path') as typeof import('node:path');
    const tablePage = fs.readFileSync(
      path.resolve(__dirname, '../../src/pages/TablePage.tsx'),
      'utf8'
    );
    expect((tablePage.match(/isVisible=\{isActive\}/g) || []).length).toBe(4);
  });
});
