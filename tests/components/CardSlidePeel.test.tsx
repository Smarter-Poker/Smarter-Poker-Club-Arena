/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CARD SLIDE — the hero peels a corner of a face-down card with a finger
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-09-04: "THE CORNERS OF THE CARDS SHOULD BE 'PEELED BACK' LIKE YOUR
 * LOOKING AT THEM AT A REAL POKER TABLE... NOT JUST CLICK TO REVEAL, IT NEEDS
 * TO FEEL AND ACT LIKE THE USER IS ACTUALLY TOUCHING THE SCREEN AND LIFTING
 * THE CARDS OFF THE FELT." And: "they should be peeled left to right."
 *
 * Pinned here, against the real SeatSlot with a fake card rectangle:
 *   1. touching the cards picks them up (data-peeling, a grip haptic);
 *   2. the peel follows the finger, from the LEFT corner, and every frame is
 *      written as CSS custom properties - no React render per move;
 *   3. letting go early drops the corner back flat;
 *   4. sliding past the commit threshold opens the hand;
 *   5. a tap is a hint, never a reveal - there is no click-to-reveal;
 *   6. the keyboard path still opens the hand (accessibility);
 *   7. the geometry (cardPeel.ts) is what the DOM sees.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import React from 'react';

const haptics: string[] = [];
const sounds: string[] = [];
vi.mock('../../src/services/SoundService', () => ({
  soundService: new Proxy({ isEnabled: () => true } as Record<string, unknown>, {
    get(t, p: string) {
      if (p in t) return t[p];
      return () => {
        sounds.push(p);
      };
    },
  }),
  haptic: {
    light: () => haptics.push('light'),
    medium: () => haptics.push('medium'),
    strong: () => haptics.push('strong'),
  },
}));

import { SeatSlot, type SeatPlayer } from '../../src/components/table/SeatSlot';
import { computePeel } from '../../src/components/table/cardPeel';

const W = 50;
const H = 70;

const hero: SeatPlayer = {
  id: 'hero',
  name: 'Hero',
  stack: 1000,
  status: 'active',
  holeCards: [
    { rank: 'A', suit: 's' },
    { rank: 'K', suit: 'h' },
  ],
  showCards: false,
  isHero: true,
} as SeatPlayer;

function renderHero(props: Record<string, unknown> = {}) {
  const view = render(
    <SeatSlot
      seatNumber={1}
      player={hero}
      position={null}
      isActive={false}
      lastAction={null}
      cardSqueezeActive={true}
      handNumber={1}
      playSounds={true}
      {...props}
    />
  );
  // jsdom has no layout: give every squeeze box a real rectangle.
  for (const el of Array.from(view.container.querySelectorAll('.seat__card--squeeze'))) {
    (el as HTMLElement).getBoundingClientRect = () =>
      ({ left: 100, top: 200, width: W, height: H, right: 150, bottom: 270 }) as DOMRect;
  }
  const row = view.container.querySelector('.seat__cards--squeeze') as HTMLElement;
  const card = view.container.querySelector('.seat__card--squeeze') as HTMLElement;
  return { ...view, row, card };
}

function pointer(
  target: Element,
  type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel',
  x: number,
  y: number
) {
  act(() => {
    target.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerId: 1,
        pointerType: 'touch',
        isPrimary: true,
        clientX: 100 + x,
        clientY: 200 + y,
      })
    );
  });
}

const progressOf = (row: HTMLElement) => Number(row.style.getPropertyValue('--peel-progress') || 0);

beforeEach(() => {
  haptics.length = 0;
  sounds.length = 0;
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) =>
    window.setTimeout(() => cb(performance.now()), 16)
  );
  vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('touching the cards picks them up', () => {
  it('a finger down marks the row peeling, pins the LEFT corner, and grips', () => {
    const { row, card } = renderHero();
    pointer(card, 'pointerdown', 40, 64); // bottom-RIGHT of the card
    expect(row.hasAttribute('data-peeling')).toBe(true);
    expect(row.getAttribute('data-peel-corner')).toBe('bl'); // left, not right
    expect(progressOf(row)).toBe(0);
    expect(haptics).toEqual(['light']);
  });

  it('a finger in the top half pins the top-left corner', () => {
    const { row, card } = renderHero();
    pointer(card, 'pointerdown', 40, 10);
    expect(row.getAttribute('data-peel-corner')).toBe('tl');
  });
});

describe('the peel follows the finger, left to right', () => {
  it('writes the geometry as CSS variables on every move, no React render', () => {
    const { row, card } = renderHero();
    pointer(card, 'pointerdown', 40, 64);
    const before = row.outerHTML.length;
    pointer(row, 'pointermove', 52, 56); // slide right and up
    expect(progressOf(row)).toBeGreaterThan(0);
    const expected = computePeel({ width: W, height: H, corner: 'bl', x: 12, y: H - 8 });
    expect(progressOf(row)).toBeCloseTo(expected.progress, 5);
    expect(row.style.getPropertyValue('--peel-cover-clip')).toBe(expected.coverClip);
    expect(row.style.getPropertyValue('--peel-flap-clip')).toBe(expected.flapClip);
    expect(row.style.getPropertyValue('--peel-flap-transform')).toBe(expected.flapTransform);
    // The markup did not change: no re-render, only style properties.
    expect(row.querySelectorAll('.seat__peel-flap').length).toBe(2);
    expect(Math.abs(row.outerHTML.length - before)).toBeLessThan(600);
  });

  it('both cards peel together from the same geometry', () => {
    const { row, card } = renderHero();
    pointer(card, 'pointerdown', 40, 64);
    pointer(row, 'pointermove', 60, 50);
    // Variables live on the ROW, so both squeeze boxes read the same frame.
    expect(row.querySelectorAll('.seat__card--squeeze').length).toBe(2);
    expect(row.style.getPropertyValue('--peel-flap-transform')).toMatch(/^matrix\(/);
  });

  it('grips again as the corner first bends, and firmer at the commit line', () => {
    const { row, card } = renderHero();
    pointer(card, 'pointerdown', 40, 64);
    pointer(row, 'pointermove', 48, 58);
    pointer(row, 'pointermove', 70, 30);
    pointer(row, 'pointermove', 90, 4);
    expect(haptics[0]).toBe('light'); // the touch
    expect(haptics).toContain('medium'); // the commit line
    expect(progressOf(row)).toBeGreaterThanOrEqual(0.45);
  });
});

describe('letting go', () => {
  it('early: the corner settles back flat and the hand stays face down', () => {
    const { row, card, container } = renderHero();
    pointer(card, 'pointerdown', 40, 64);
    pointer(row, 'pointermove', 50, 56);
    expect(progressOf(row)).toBeGreaterThan(0);
    expect(progressOf(row)).toBeLessThan(0.45);
    pointer(row, 'pointerup', 50, 56);
    expect(row.hasAttribute('data-peeling')).toBe(false);
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(row.style.getPropertyValue('--peel-progress')).toBe('');
    expect(container.querySelector('.seat__cards--squeeze')).toBeTruthy();
    expect(container.querySelector('.seat__cards--squeeze-open')).toBeNull();
    expect(sounds).not.toContain('playCardSqueeze');
  });

  it('past the commit line: the corner flies open and the hand is revealed', () => {
    const { row, card, container } = renderHero();
    pointer(card, 'pointerdown', 40, 64);
    pointer(row, 'pointermove', 70, 30);
    pointer(row, 'pointermove', 90, 4);
    expect(progressOf(row)).toBeGreaterThanOrEqual(0.45);
    pointer(row, 'pointerup', 90, 4);
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(container.querySelector('.seat__cards--squeeze')).toBeNull();
    expect(container.querySelector('.seat__cards--squeeze-open')).toBeTruthy();
    expect(sounds).toContain('playCardSqueeze');
  });

  it('a cancelled pointer drops the corner too', () => {
    const { row, card } = renderHero();
    pointer(card, 'pointerdown', 40, 64);
    pointer(row, 'pointermove', 50, 56);
    pointer(row, 'pointercancel', 50, 56);
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(row.style.getPropertyValue('--peel-progress')).toBe('');
    expect(row.hasAttribute('data-peeling')).toBe(false);
  });
});

describe('there is no click to reveal', () => {
  it('a tap bounces a hint and leaves the hand face down', () => {
    const { row, card, container } = renderHero();
    pointer(card, 'pointerdown', 40, 64);
    pointer(row, 'pointerup', 41, 64);
    expect(container.querySelector('.seat__cards--squeeze-hint')).toBeTruthy();
    expect(container.querySelector('.seat__cards--squeeze')).toBeTruthy();
    expect(sounds).not.toContain('playCardSqueeze');
  });

  it('a second tap is still not a reveal', () => {
    const { row, card, container } = renderHero();
    pointer(card, 'pointerdown', 40, 64);
    pointer(row, 'pointerup', 40, 64);
    act(() => {
      vi.advanceTimersByTime(100);
    });
    pointer(card, 'pointerdown', 40, 64);
    pointer(row, 'pointerup', 40, 64);
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(container.querySelector('.seat__cards--squeeze')).toBeTruthy();
    expect(container.querySelector('.seat__cards--squeeze-open')).toBeNull();
  });

  it('Enter opens the hand (a peel is not something a screen reader can do)', () => {
    const { row, container } = renderHero();
    act(() => {
      row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(container.querySelector('.seat__cards--squeeze-open')).toBeTruthy();
  });
});

describe('a card you have not turned over does not tell you what it is', () => {
  it('the live hand-strength label is withheld while the cards are face down', () => {
    const { container } = renderHero({ handStrength: 'Pair Of Kings' });
    expect(container.querySelector('.seat__strength')).toBeNull();
    expect(container.textContent).not.toContain('Pair Of Kings');
  });

  it('and appears the moment the peel commits', () => {
    const { row, card, container } = renderHero({ handStrength: 'Pair Of Kings' });
    pointer(card, 'pointerdown', 40, 64);
    pointer(row, 'pointermove', 70, 30);
    pointer(row, 'pointermove', 90, 4);
    pointer(row, 'pointerup', 90, 4);
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(container.querySelector('.seat__strength')?.textContent).toBe('Pair Of Kings');
  });

  it('is unaffected when Card Slide is off', () => {
    const { container } = renderHero({ handStrength: 'Pair Of Kings', cardSqueezeActive: false });
    expect(container.querySelector('.seat__strength')?.textContent).toBe('Pair Of Kings');
  });
});

describe('the markup', () => {
  it('carries face, cover, flap and both shade bands per card', () => {
    const { container } = renderHero();
    for (const box of Array.from(container.querySelectorAll('.seat__card--squeeze'))) {
      expect(box.querySelector('.seat__squeeze-face--under')).toBeTruthy();
      expect(box.querySelector('.seat__squeeze-face--cover')).toBeTruthy();
      expect(box.querySelector('.seat__peel-flap .seat__peel-flap-inner')).toBeTruthy();
      expect(box.querySelector('.seat__peel-shade--under')).toBeTruthy();
      expect(box.querySelector('.seat__peel-shade--flap')).toBeTruthy();
    }
  });

  it('draws the rank and suit in the bottom-left corner of the face, under the peel', () => {
    // Dan 2026-09-04: "THE QJ ARE ON THE BOTTOM LEFT HAND CORNER WHEN YOU
    // ARE PEELING THEM BACK." The deck art has one index, top-left; a real
    // card shows its rank at whichever corner you lift.
    const { container } = renderHero();
    const idx = Array.from(container.querySelectorAll('.seat__peel-index'));
    expect(idx.length).toBe(2);
    expect(idx[0].querySelector('.seat__peel-index-rank')?.textContent).toBe('A');
    expect(idx[0].className).toContain('seat__peel-index--black');
    expect(idx[1].querySelector('.seat__peel-index-rank')?.textContent).toBe('K');
    expect(idx[1].className).toContain('seat__peel-index--red');
    // Inside the face layer (revealed by the peel), never on the cover.
    for (const el of idx) {
      expect(el.closest('.seat__squeeze-face--under')).toBeTruthy();
    }
  });

  it('spells ten as 10', () => {
    const { container } = renderHero({
      player: { ...hero, holeCards: [{ rank: 'T', suit: 'c' }] },
    });
    expect(container.querySelector('.seat__peel-index-rank')?.textContent).toBe('10');
  });

  it('is announced as a peel, not a drag-up', () => {
    const { row } = renderHero();
    expect(row.getAttribute('aria-label')).toMatch(/Peel/);
  });
});
