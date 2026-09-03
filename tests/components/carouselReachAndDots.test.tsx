/**
 * THE CAROUSEL IS A LIST OF CLUBS YOU CAN OPEN — ALL OF THEM, FROM ANYWHERE.
 *
 * Dan, 2026-08-23:
 *   "even though the one card is front and center, you should still be able to
 *    click on any card to go to that club or union. Also make sure that if a
 *    user has 4, 5, 6 clubs etc that they all appear... the pill should be in
 *    the middle and dots on each side for the other cards."
 *
 * Three separate contracts, each of which had already regressed once or was
 * about to, and none of which any existing test could see:
 *
 *  1. CLICKING. Off-centre cards carried `inert`, which removes an element from
 *     hit testing and from the tab order alike, so the onClick on it could not
 *     fire. Clicking a neighbour did nothing whatsoever - not "centred it
 *     first", nothing. A test that only ever clicks the middle card would have
 *     stayed green through all of it.
 *
 *  2. REACH. With N clubs every one of them must be able to become the centre.
 *     The strip only mounts five at a time, so "all my clubs are there" is a
 *     claim about the fold, not about the DOM, and has to be checked as one.
 *
 *  3. THE PILL. It marked the current club's position in list order, so with
 *     three clubs and the third one centred it sat hard right while the card it
 *     described was in the middle. The indicator and the carousel disagreed
 *     about where the middle was.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { Carousel } from '../../src/components/carousel/Carousel';
import { dotWindow, DOT_WINDOW } from '../../src/components/carousel/CarouselDots';

function withTrackWidth(px: number) {
  return vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => px);
}

function clubs(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `Club ${i + 1}`);
}

function renderStrip(items: string[], onSelect?: (c: string, i: number) => void) {
  return render(
    <Carousel
      items={items}
      getKey={(c) => c}
      renderItem={(c) => <div data-testid={`card-${c}`}>{c}</div>}
      onSelect={onSelect}
      visibleCards={3}
      spacingRatio={0.94}
      edgeScale={0.8}
      itemNoun="Club"
      ariaLabel="Your Clubs"
    />
  );
}

function itemEls(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('.sp-carousel__item'));
}

function translateXOf(el: HTMLElement): number {
  const m = /translateX\((-?[\d.]+)px\)/.exec(el.style.transform || '');
  return m ? parseFloat(m[1]) : NaN;
}

describe('clicking any visible card opens that club', () => {
  it('opens a NEIGHBOUR, not just the centred card', () => {
    const spy = withTrackWidth(928);
    const onSelect = vi.fn();
    renderStrip(clubs(3), onSelect);

    const left = itemEls().find((el) => translateXOf(el) < -1)!;
    const right = itemEls().find((el) => translateXOf(el) > 1)!;
    expect(left).toBeDefined();
    expect(right).toBeDefined();

    fireEvent.click(left);
    fireEvent.click(right);

    // Two opens, and neither of them is the centre card.
    expect(onSelect).toHaveBeenCalledTimes(2);
    const opened = onSelect.mock.calls.map((c) => c[0]);
    expect(new Set(opened).size).toBe(2);

    spy.mockRestore();
    cleanup();
  });

  it('leaves the visible neighbours reachable rather than inert', () => {
    // `inert` is the mechanism that broke this. Assert on it directly: it is
    // the difference between "you must tap twice" and "the tap does nothing".
    const spy = withTrackWidth(928);
    renderStrip(clubs(3));

    const onStage = itemEls().filter((el) => Math.abs(translateXOf(el)) < 400);
    expect(onStage.length).toBe(3);
    for (const el of onStage) {
      expect(el.hasAttribute('inert')).toBe(false);
    }

    spy.mockRestore();
    cleanup();
  });

  it('still refuses to treat a SWIPE as a click', () => {
    /* The half of the engine's rule that stays. Without it every swipe would
       open whatever club it happened to start on, which is worse than the bug
       being fixed here. */
    const spy = withTrackWidth(928);
    const onSelect = vi.fn();
    renderStrip(clubs(3), onSelect);
    const track = document.querySelector('.sp-carousel__track') as HTMLElement;
    const centre = itemEls().find((el) => Math.abs(translateXOf(el)) < 1)!;

    /* mousedown on the track, but mousemove/mouseup on WINDOW - that is where
       the component binds them (Carousel.tsx: `window.addEventListener`), so a
       drag driven at the element never moves startX/lastX and the guard reads
       a distance of zero. Getting this wrong is how a test reports that
       swipe-to-open is broken when it is fine, so it is worth saying out loud
       rather than leaving as a mystery for the next reader. */
    fireEvent.mouseDown(track, { clientX: 400 });
    fireEvent.mouseMove(window, { clientX: 250 });
    fireEvent.mouseUp(window, { clientX: 250 });
    fireEvent.click(centre);

    expect(onSelect).not.toHaveBeenCalled();

    spy.mockRestore();
    cleanup();
  });
});

describe('every club is reachable, however many there are', () => {
  for (const n of [4, 5, 6, 12]) {
    it(`lets all ${n} clubs take the centre`, () => {
      const spy = withTrackWidth(928);
      const onIndexChange = vi.fn();
      const items = clubs(n);
      render(
        <Carousel
          items={items}
          getKey={(c) => c}
          renderItem={(c) => <div>{c}</div>}
          onIndexChange={onIndexChange}
          visibleCards={3}
          spacingRatio={0.94}
          edgeScale={0.8}
          ariaLabel="Your Clubs"
        />
      );

      /* Reach is a property of the FOLD, not of the DOM: the strip mounts five
         cards at a time no matter how many clubs there are. So ask the
         indicator, which addresses clubs by real index - every club must have a
         dot slot that jumps to it. */
      const reachable = new Set<number>();
      for (let current = 0; current < n; current++) {
        for (const d of dotWindow(n, current)) reachable.add(d.index);
      }
      expect(reachable.size).toBe(n);

      spy.mockRestore();
      cleanup();
    });
  }

  it('mounts a bounded number of cards even with a long list', () => {
    // The flip side of reach: 300 clubs must not mean 300 mounted club panels.
    const spy = withTrackWidth(928);
    renderStrip(clubs(300));
    expect(itemEls().length).toBeLessThanOrEqual(6);
    spy.mockRestore();
    cleanup();
  });
});

describe('the pill sits in the middle', () => {
  it('centres the current club at three clubs, whichever one it is', () => {
    // The exact case in Dan's screenshot: Midway Union, third of three, centred
    // on stage while the pill sat hard right.
    for (let current = 0; current < 3; current++) {
      const dots = dotWindow(3, current);
      expect(dots).toHaveLength(3);
      expect(dots[1].isCurrent).toBe(true);
      expect(dots[1].index).toBe(current);
      // ...and a real, different club either side of it.
      expect(dots[0].isCurrent).toBe(false);
      expect(dots[2].isCurrent).toBe(false);
      expect(new Set(dots.map((d) => d.index)).size).toBe(3);
    }
  });

  it('keeps the pill dead centre for every odd count and every long list', () => {
    for (const total of [3, 5, 7, 9, 30, 300]) {
      for (const current of [0, 1, Math.floor(total / 2), total - 1]) {
        const dots = dotWindow(total, current);
        const pill = dots.findIndex((d) => d.isCurrent);
        expect(pill).toBe(Math.floor(dots.length / 2));
        expect(dots[pill].index).toBe(current);
      }
    }
  });

  it('never grows past the window, however many clubs there are', () => {
    expect(dotWindow(300, 7)).toHaveLength(DOT_WINDOW);
    expect(dotWindow(8, 0)).toHaveLength(DOT_WINDOW);
  });

  it('shows every club its own dot while the list is short', () => {
    // 4, 5 and 6 clubs: nobody is hidden from the row.
    for (const total of [2, 3, 4, 5, 6, 7]) {
      const dots = dotWindow(total, 0);
      expect(dots).toHaveLength(total);
      expect(new Set(dots.map((d) => d.index)).size).toBe(total);
    }
  });

  it('wraps the window the way the strip wraps', () => {
    // Centred on the first of thirty, the dots to its left are the LAST clubs.
    const dots = dotWindow(30, 0);
    expect(dots.map((d) => d.index)).toEqual([27, 28, 29, 0, 1, 2, 3]);
  });

  it('renders the pill in the middle of the DOM row too', () => {
    const spy = withTrackWidth(928);
    renderStrip(clubs(3));
    const row = Array.from(document.querySelectorAll('.carousel-dots .dot'));
    expect(row).toHaveLength(3);
    expect(row[1].classList.contains('active')).toBe(true);
    expect(row[0].classList.contains('active')).toBe(false);
    expect(row[2].classList.contains('active')).toBe(false);
    spy.mockRestore();
    cleanup();
  });
});
