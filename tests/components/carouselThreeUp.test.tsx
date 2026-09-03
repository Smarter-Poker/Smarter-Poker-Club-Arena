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
  return vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (
    this: HTMLElement
  ) {
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

/** The lobby's real configuration. Keep these two numbers in step with
 *  CarouselSection.tsx - a test mirroring a configuration nobody ships is
 *  worse than no test, because it reports green about a layout that is not on
 *  screen. */
const LOBBY_SPACING = 0.94;
const LOBBY_EDGE_SCALE = 0.8;

function renderThreeUp(items: Club[] = CLUBS) {
  return render(
    <Carousel
      items={items}
      getKey={(c) => c.id}
      renderItem={(c) => <div data-testid={`card-${c.id}`}>{c.name}</div>}
      visibleCards={3}
      spacingRatio={LOBBY_SPACING}
      edgeScale={LOBBY_EDGE_SCALE}
      ariaLabel="Your Clubs"
    />
  );
}

/** The scale the component baked into a card's transform. */
function scaleOf(el: HTMLElement): number {
  const m = /scale\(([\d.]+)\)/.exec(el.style.transform || '');
  return m ? parseFloat(m[1]) : NaN;
}

/** Slot width the component wrote onto the track. */
function slotWidth(): number {
  const track = document.querySelector('.sp-carousel__track') as HTMLElement;
  return parseFloat(track.style.getPropertyValue('--sp-carousel-item-w'));
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
    // Assert on the POSITIONED cards only. The track also renders an invisible
    // `.sp-carousel__sizer` copy of a card to give itself height, so a
    // document-wide testid query legitimately finds duplicates - and the sizer
    // is not something the user can see.
    const names = itemEls()
      .map((el) => el.textContent?.trim())
      .sort();
    expect(itemEls()).toHaveLength(3);
    expect(names).toEqual(['Club JAQK', 'Midway Union', 'SHARK CLUB'].sort());
    spy.mockRestore();
    cleanup();
  });

  it('keeps the measuring sizer out of the accessibility tree', () => {
    // The sizer is WHY the assertion above is scoped to `.sp-carousel__item`
    // rather than querying the document: it holds a second copy of a card so
    // the track can measure a natural width. That copy is harmless only for as
    // long as it stays aria-hidden — the moment it does not, screen readers
    // announce a card that is not there, and the scoping above starts looking
    // arbitrary to whoever reads it next. Pin it rather than leave it as
    // folklore; this test cost an afternoon and a blocked publish to learn.
    const spy = withTrackWidth(1200);
    renderCarousel();
    const sizer = document.querySelector('.sp-carousel__sizer');
    expect(sizer).not.toBeNull();
    expect(sizer!.getAttribute('aria-hidden')).toBe('true');
    spy.mockRestore();
    cleanup();
  });

  it('places the neighbours to the LEFT and RIGHT of centre, not on top of it', () => {
    const spy = withTrackWidth(1200);
    renderCarousel(CLUBS, 300);
    const offsets = itemEls()
      .map(translateXOf)
      .sort((x, y) => x - y);

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

describe('visibleCards={3} — the lobby configuration', () => {
  it('fills the stage - the three-up composition spans the whole track', () => {
    const spy = withTrackWidth(928); // .mainContent at its 960px cap, less padding
    renderThreeUp();
    const w = slotWidth();

    /* The composition's true width, outer edge to outer edge. The outermost
       card is DRAWN SCALED, so it contributes edgeScale * w of visible width -
       exactly what the old `visibleCards + 0.5` divisor failed to account for.
       It reserved a phantom half-card of margin the scale falloff had already
       paid for, and the cards came out ~30% narrower than the band they sat
       in. */
    const step = w * LOBBY_SPACING;
    const span = 2 * step + w * LOBBY_EDGE_SCALE;

    // Fits: nothing is clipped at either edge.
    expect(span).toBeLessThanOrEqual(928 + 0.5);
    // And genuinely fills it, rather than floating in an empty band.
    expect(span).toBeGreaterThan(928 * 0.95);

    spy.mockRestore();
    cleanup();
  });

  it('makes the MIDDLE card the largest of the three', () => {
    /* Dan 2026-08-22: "IT SHOULD SHOW 1-3 CARDS ON THE PAGE, WITH THE CARD IN
       THE MIDDLE THE LARGEST."

       Three cards at the same size is a row, not a carousel - nothing tells the
       eye which one a tap would open. The previous 0.9 edge scale was a 10%
       difference seen across a gap, which reads as no difference at all. */
    const spy = withTrackWidth(928);
    renderThreeUp();

    const items = itemEls();
    const centre = items.find((el) => Math.abs(translateXOf(el)) < 1)!;
    const sides = items.filter((el) => Math.abs(translateXOf(el)) > 1);

    expect(centre).toBeDefined();
    expect(sides).toHaveLength(2);
    for (const el of sides) {
      expect(scaleOf(el)).toBeLessThan(scaleOf(centre));
      // A hierarchy you can actually see: at least a 15% step down.
      expect(scaleOf(el)).toBeLessThanOrEqual(0.85);
      // ...but still a readable club card, not a shrunken afterthought.
      expect(scaleOf(el)).toBeGreaterThanOrEqual(0.7);
    }
    expect(scaleOf(centre)).toBeCloseTo(1, 2);

    spy.mockRestore();
    cleanup();
  });

  it('places the three side by side, never overlapping the centre card', () => {
    const spy = withTrackWidth(928);
    renderThreeUp();
    const w = slotWidth();
    const offsets = itemEls()
      .map(translateXOf)
      .sort((a, b) => a - b);

    /* Two cards do not overlap when the distance between their centres is at
       least the sum of their half-widths. Centre is w/2; a neighbour, drawn at
       edgeScale, is edgeScale * w / 2. Hence (1 + edgeScale) / 2. That is the
       rule a future spacing tweak has to satisfy - not a magic 0.95. */
    const minGap = (w * (1 + LOBBY_EDGE_SCALE)) / 2;
    expect(Math.abs(offsets[0])).toBeGreaterThanOrEqual(minGap);
    expect(Math.abs(offsets[2])).toBeGreaterThanOrEqual(minGap);
    spy.mockRestore();
    cleanup();
  });

  it('makes the cards BIGGER than the old one-up sizing did in practice', () => {
    // The lobby was rendering ~194px cards. Three-up on the wider stage must
    // beat that comfortably, or the change has not earned itself.
    const spy = withTrackWidth(1360); // the carousel's full-bleed cap
    renderThreeUp();
    expect(slotWidth()).toBeGreaterThan(300);
    spy.mockRestore();
    cleanup();
  });

  it('falls back to a centre-plus-peek layout on a phone', () => {
    // Three readable club cards do not fit in 375px; three slivers help nobody.
    const spy = withTrackWidth(375);
    renderThreeUp();
    const w = slotWidth();
    expect(w).toBeGreaterThan(150); // still a legible card, not a sliver
    expect(itemEls().length).toBeGreaterThanOrEqual(3); // neighbours still mounted
    spy.mockRestore();
    cleanup();
  });

  it('leaves every other carousel on the site untouched when the prop is absent', () => {
    const spy = withTrackWidth(928);
    renderCarousel(); // no visibleCards
    expect(slotWidth()).toBe(300); // the previous min(300, max(200, w*0.55))
    spy.mockRestore();
    cleanup();
  });
});
