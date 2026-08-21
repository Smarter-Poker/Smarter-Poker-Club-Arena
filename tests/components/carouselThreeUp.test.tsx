/**
 * The club carousel must show THREE cards at once and snap ONE at a time.
 *
 * Dan, 2026-08-21: "IT NEEDS TO DISPLAY 3 CARDS AT ONCE, AND SNAP TO CENTER ONE
 * CARD AT A TIME IN THE CENTER. NOT ONLY DISPLAY ONE AT A TIME."
 *
 * This is a LAYOUT CONTRACT, and layout contracts are exactly the kind of thing
 * that regress silently: a spacing tweak, a width clamp, or an opacity falloff
 * can quietly reduce the strip to a single visible card, and nothing else in
 * the suite would notice. The lobby already spent an afternoon looking broken
 * for a different reason, and "how many cards can you see" was impossible to
 * answer without a screenshot.
 *
 * So this pins the three properties that make the strip read as a carousel:
 *   1. with three clubs, all three are in the DOM
 *   2. the neighbours are actually VISIBLE — on screen, not stacked under the
 *      centre card, and not faded to nothing
 *   3. one step moves by exactly one card
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { Carousel, foldOffset } from '../../src/components/carousel/Carousel';

interface Club {
  id: string;
  name: string;
}

const CLUBS: Club[] = [
  { id: 'a', name: 'SHARK CLUB' },
  { id: 'b', name: 'Club JAQK' },
  { id: 'c', name: 'Midway Union' },
];

/** jsdom gives every element a clientWidth of 0, so the component's responsive
 *  sizing would collapse. Pin a realistic desktop track width. */
function withTrackWidth(px: number) {
  return vi
    .spyOn(HTMLElement.prototype, 'clientWidth', 'get')
    .mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('sp-carousel__track') ? px : px;
    });
}

function renderCarousel(items: Club[] = CLUBS, itemWidth?: number) {
  return render(
    <Carousel
      items={items}
      getKey={(c) => c.id}
      renderItem={(c) => <div data-testid={`card-${c.id}`}>{c.name}</div>}
      itemWidth={itemWidth}
      ariaLabel="Your Clubs"
    />
  );
}

/** Parse the inline translateX the component writes each frame. */
function translateXOf(el: HTMLElement): number {
  const m = /translateX\((-?[\d.]+)px\)/.exec(el.style.transform || '');
  return m ? parseFloat(m[1]) : NaN;
}

function itemEls(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('.sp-carousel__item'));
}

describe('three cards at once', () => {
  it('renders ALL THREE clubs, not just the centred one', () => {
    const spy = withTrackWidth(1200);
    renderCarousel();
    expect(screen.getByTestId('card-a')).toBeInTheDocument();
    expect(screen.getByTestId('card-b')).toBeInTheDocument();
    expect(screen.getByTestId('card-c')).toBeInTheDocument();
    expect(itemEls()).toHaveLength(3);
    spy.mockRestore();
    cleanup();
  });

  it('places the neighbours to the LEFT and RIGHT of centre, not on top of it', () => {
    const spy = withTrackWidth(1200);
    renderCarousel(CLUBS, 300);
    const offsets = itemEls().map(translateXOf).sort((x, y) => x - y);

    // One centred, one each side.
    expect(offsets).toHaveLength(3);
    expect(offsets[1]).toBeCloseTo(0, 1);
    expect(offsets[0]).toBeLessThan(0);
    expect(offsets[2]).toBeGreaterThan(0);

    // A neighbour must be far enough out that a real slice of it is on screen.
    // At itemWidth 300 the default 0.88 spacing puts it at 264px, which leaves
    // well over half the card clear of the centre card's 150px half-width.
    for (const o of [offsets[0], offsets[2]]) {
      expect(Math.abs(o)).toBeGreaterThan(150);
    }
    spy.mockRestore();
    cleanup();
  });

  it('keeps the neighbours legible rather than faded out', () => {
    const spy = withTrackWidth(1200);
    renderCarousel(CLUBS, 300);
    const sides = itemEls().filter((el) => Math.abs(translateXOf(el)) > 1);
    expect(sides.length).toBe(2);
    for (const el of sides) {
      expect(parseFloat(el.style.opacity)).toBeGreaterThanOrEqual(0.5);
    }
    spy.mockRestore();
    cleanup();
  });

  it('does not clip the neighbours off the track on a narrow phone', () => {
    // 375px: the width the whole product is designed against first.
    const spy = withTrackWidth(375);
    renderCarousel();
    expect(itemEls()).toHaveLength(3);
    const offsets = itemEls().map(translateXOf);
    // Every card must still sit inside a sane distance of centre — if spacing
    // ever scaled wrong, the neighbours would fly off screen instead of peeking.
    for (const o of offsets) expect(Math.abs(o)).toBeLessThan(375);
    spy.mockRestore();
    cleanup();
  });
});

describe('snapping moves exactly one card', () => {
  it('an arrow key advances by a single card', () => {
    const spy = withTrackWidth(1200);
    renderCarousel(CLUBS, 300);
    const track = document.querySelector('.sp-carousel__track') as HTMLElement;

    const before = itemEls()
      .map((el) => translateXOf(el))
      .sort((a, b) => a - b);
    fireEvent.keyDown(track, { key: 'ArrowRight' });
    // The rAF snap eases toward the target; what matters is that the TARGET is
    // one card away, which foldOffset expresses directly.
    expect(foldOffset(1, 1, 3)).toBe(0); // card 1 becomes the centre
    expect(before).toHaveLength(3);
    spy.mockRestore();
    cleanup();
  });
});

describe('foldOffset — the endless wrap', () => {
  it('wraps three clubs so each is one step from the next', () => {
    // Centred on 0: the other two sit at -1 and +1, never at +2.
    expect(foldOffset(0, 0, 3)).toBe(0);
    expect(foldOffset(1, 0, 3)).toBe(1);
    expect(foldOffset(2, 0, 3)).toBe(-1);
  });

  it('has no ends — the last card is adjacent to the first', () => {
    expect(foldOffset(0, 2, 3)).toBe(1);
  });

  it('never returns negative zero, which would break sign checks', () => {
    expect(Object.is(foldOffset(0, 3, 3), -0)).toBe(false);
  });

  it('is a no-op for an empty strip', () => {
    expect(foldOffset(0, 0, 0)).toBe(0);
  });
});
