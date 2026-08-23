/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE CAROUSEL ACTUALLY SWIPES
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * foldOffset is unit-tested next door and the geometry was measured in a real
 * browser. What neither covers is the wiring: listeners attached to the right
 * element, the sensitivity actually applied, the release deciding a target,
 * and the rAF loop easing onto it. That is the half that silently does
 * nothing if a listener is bound to the wrong node.
 *
 * jsdom has no layout, so this asserts on WHICH CARD IS ACTIVE rather than on
 * pixels. That is the user-visible fact anyway: after a swipe, a different
 * club is the one in the middle that a tap would open.
 */
import { render, screen, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Carousel } from '../../src/components/carousel/Carousel';

const CLUBS = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo'];

function renderCarousel(onSelect?: (v: string, i: number) => void, onDragStart?: () => void) {
  return render(
    <Carousel
      items={CLUBS}
      getKey={(c) => c}
      itemWidth={300}
      onSelect={onSelect}
      onDragStart={onDragStart}
      renderItem={(c, _i, isActive) => <div data-active={isActive}>{c}</div>}
    />
  );
}

const track = () => document.querySelector('.sp-carousel__track') as HTMLElement;

/** The club currently in the middle. */
const activeName = () =>
  (document.querySelector('.sp-carousel__item.is-active') as HTMLElement | null)?.textContent ??
  null;

/** Run the rAF snap loop until it settles. */
async function settle(frames = 240) {
  for (let i = 0; i < frames; i++) {
    await act(async () => {
      vi.advanceTimersByTime(16);
    });
  }
}

/**
 * A touch drag of `dx` px over `ms`, delivered in steps so velocity is real.
 *
 * The DURATION is load-bearing, not decoration. The engine's release rule
 * branches on px/ms: above 0.5 it is a fling and skips up to three cards,
 * above 0.1 it carries momentum, below that it just snaps to the nearest. A
 * test that drags 400px in 300ms is testing the fling, whatever it says on
 * the tin. At the reference width of 1000px the sensitivity is 0.003, so one
 * card is 1/0.003 = 333px of travel.
 */
async function swipe(dx: number, ms = 300) {
  const el = track();
  const steps = 10;
  const touch = (x: number) => ({ clientX: x, clientY: 0 }) as Touch;

  await act(async () => {
    el.dispatchEvent(
      new TouchEvent('touchstart', { touches: [touch(0)] as unknown as Touch[], bubbles: true })
    );
  });
  for (let i = 1; i <= steps; i++) {
    await act(async () => {
      vi.advanceTimersByTime(ms / steps);
      el.dispatchEvent(
        new TouchEvent('touchmove', {
          touches: [touch((dx * i) / steps)] as unknown as Touch[],
          bubbles: true,
          cancelable: true,
        })
      );
    });
  }
  await act(async () => {
    el.dispatchEvent(new TouchEvent('touchend', { bubbles: true }));
  });
  await settle();
}

describe('Carousel opening position', () => {
  beforeEach(() => {
    // swipe() drives the rAF snap loop through the timer API.
    vi.useFakeTimers();
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get: () => 1000,
    });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens on the requested card, not always the first', () => {
    /* With an endless strip and unlimited clubs, landing on someone else's
       club instead of your own is several swipes every time you come back. */
    render(
      <Carousel
        items={CLUBS}
        getKey={(c) => c}
        itemWidth={300}
        initialIndex={3}
        renderItem={(c, _i, isActive) => <div data-active={isActive}>{c}</div>}
      />
    );
    expect(activeName()).toBe('Delta');
  });

  it('survives an index that is out of range', () => {
    // A stale id from storage, or a club that has since been left.
    render(
      <Carousel
        items={CLUBS}
        getKey={(c) => c}
        itemWidth={300}
        initialIndex={99}
        renderItem={(c, _i, isActive) => <div data-active={isActive}>{c}</div>}
      />
    );
    expect(activeName()).not.toBeNull();
  });

  it('survives a negative index', () => {
    render(
      <Carousel
        items={CLUBS}
        getKey={(c) => c}
        itemWidth={300}
        initialIndex={-2}
        renderItem={(c, _i, isActive) => <div data-active={isActive}>{c}</div>}
      />
    );
    expect(activeName()).toBe('Delta'); // -2 folds to index 3 of 5
  });

  it('does not fight the player once they have swiped', async () => {
    // initialIndex is a STARTING position, not a controlled value; re-reading
    // it on every render would yank a card back mid-session.
    const { rerender } = render(
      <Carousel
        items={CLUBS}
        getKey={(c) => c}
        itemWidth={300}
        initialIndex={0}
        renderItem={(c, _i, isActive) => <div data-active={isActive}>{c}</div>}
      />
    );
    await swipe(-333, 4000);
    expect(activeName()).toBe('Bravo');
    rerender(
      <Carousel
        items={CLUBS}
        getKey={(c) => c}
        itemWidth={300}
        initialIndex={4}
        renderItem={(c, _i, isActive) => <div data-active={isActive}>{c}</div>}
      />
    );
    expect(activeName(), 'a later initialIndex moved the player').toBe('Bravo');
  });
});

describe('Carousel position indicator', () => {
  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get: () => 1000,
    });
  });

  it('shows one tappable dot per club for a short list', () => {
    render(
      <Carousel
        items={CLUBS}
        getKey={(c) => c}
        itemWidth={300}
        itemNoun="Club"
        renderItem={(c) => <div>{c}</div>}
      />
    );
    // 5 clubs, under MAX_DOTS.
    expect(document.querySelectorAll('.carousel-dots .dot')).toHaveLength(CLUBS.length);
    expect(document.querySelector('.dot.active')).not.toBeNull();
  });

  it('keeps the dots AND adds a count once the list outgrows the window', () => {
    /* REPLACED 2026-08-23. This used to assert the dots vanished entirely above
       eight clubs, leaving only "1 / 30" text.

       That deleted the control at exactly the moment it became useful: with
       thirty clubs you most want something to tap to move between them, and
       there was nothing. Thirty dots really is a texture rather than a target -
       the old comment was right about that - but the fix is to window the dots,
       not to remove them. Seven never outgrow their space.

       So both now: a seven-dot window you can still tap, and the count beside
       it, which is the one thing an endless strip cannot show on its own. */
    const many = Array.from({ length: 30 }, (_, i) => `Club ${i + 1}`);
    render(
      <Carousel items={many} getKey={(c) => c} itemWidth={300} renderItem={(c) => <div>{c}</div>} />
    );
    expect(document.querySelectorAll('.carousel-dots .dot')).toHaveLength(7);
    expect(document.querySelector('.carousel-counter')?.textContent).toBe('1 / 30');
  });

  it('shows nothing at all for a single club', () => {
    render(
      <Carousel
        items={['Solo']}
        getKey={(c) => c}
        itemWidth={300}
        renderItem={(c) => <div>{c}</div>}
      />
    );
    expect(document.querySelector('.carousel-dots')).toBeNull();
  });

  it('labels every dot for a screen reader', () => {
    render(
      <Carousel
        items={CLUBS}
        getKey={(c) => c}
        itemWidth={300}
        itemNoun="Club"
        renderItem={(c) => <div>{c}</div>}
      />
    );
    expect(screen.getByRole('tab', { name: 'Club 1 Of 5' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Club 5 Of 5' })).toBeInTheDocument();
  });
});

describe('Carousel swipe', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // jsdom reports 0 for clientWidth; give the track a width so the
    // width-relative sensitivity is not a division by zero.
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get: () => 1000,
    });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts with the first club in the middle', () => {
    renderCarousel();
    expect(activeName()).toBe('Alpha');
  });

  it('renders neighbours, not the whole list', () => {
    renderCarousel();
    // VISIBLE_HALF is 2.5, so five of five here, but each is a real node and
    // only ONE is active.
    expect(document.querySelectorAll('.sp-carousel__item.is-active')).toHaveLength(1);
  });

  it('a deliberate one-card drag brings the NEXT club to the middle', async () => {
    renderCarousel();
    // 333px is exactly one card at this width; 4s makes it far too slow to
    // register as a fling, so it lands on its neighbour and stops.
    await swipe(-333, 4000);
    expect(activeName()).toBe('Bravo');
  });

  it('a one-card drag RIGHT from the first club wraps to the LAST', async () => {
    // The whole point of "endless": no dead end at either edge.
    renderCarousel();
    await swipe(333, 4000);
    expect(activeName()).toBe('Echo');
  });

  it('a hard flick skips several clubs instead of crawling one at a time', async () => {
    // 400px in 300ms is 1.33px/ms, well past the 0.5 fling threshold. With
    // dozens of clubs this is the difference between reaching the far end and
    // swiping thirty times, which is the complaint that started this.
    renderCarousel();
    await swipe(-400, 300);
    expect(activeName()).not.toBe('Alpha');
    expect(activeName()).not.toBe('Bravo');
  });

  it('never runs out of clubs, however far it is flung', async () => {
    renderCarousel();
    for (let i = 0; i < 6; i++) await swipe(-400, 300);
    // A native scroller would have hit its end long ago and stopped.
    expect(activeName()).not.toBeNull();
  });

  it('opens the centre club on a tap that did not drag', async () => {
    const onSelect = vi.fn();
    renderCarousel(onSelect);
    await act(async () => {
      // Target the ACTIVE item, not the text. .sp-carousel__sizer renders a
      // second, invisible copy of the first card to give the track its height,
      // so a text query legitimately matches twice.
      (document.querySelector('.sp-carousel__item.is-active') as HTMLElement).click();
    });
    expect(onSelect).toHaveBeenCalledWith('Alpha', 0);
  });

  it('announces a drag so a card can cancel its press-and-hold', async () => {
    /* The club cards open a context menu after 500ms of touch. A deliberate
       slow swipe is easily longer than that, so without this signal the menu
       opened in the middle of the gesture and the swipe was lost. The carousel
       is the only thing that can tell a hold from a drag. */
    const onDragStart = vi.fn();
    renderCarousel(undefined, onDragStart);
    await swipe(-333, 4000);
    expect(onDragStart).toHaveBeenCalled();
  });

  it('does not announce a drag for a tap that never moved', async () => {
    const onDragStart = vi.fn();
    renderCarousel(undefined, onDragStart);
    await swipe(-4, 200); // under the 10px slop
    expect(onDragStart).not.toHaveBeenCalled();
  });

  it('announces the drag only ONCE per gesture', async () => {
    // It cancels a timer; firing it on every touchmove would be 10 calls for
    // one swipe and would mask a real double-gesture bug later.
    const onDragStart = vi.fn();
    renderCarousel(undefined, onDragStart);
    await swipe(-333, 4000);
    expect(onDragStart).toHaveBeenCalledTimes(1);
  });

  it('keeps the height sizer out of the accessibility tree', () => {
    renderCarousel();
    const sizer = document.querySelector('.sp-carousel__sizer');
    expect(sizer, 'no sizer, so the track has no height of its own').not.toBeNull();
    expect(sizer?.getAttribute('aria-hidden')).toBe('true');
  });

  it('marks off-centre cards inert rather than aria-hidden', () => {
    // The club card inside is focusable. aria-hidden on something reachable by
    // Tab lands a keyboard user on a control screen readers were told is not
    // there; inert removes it from both.
    renderCarousel();
    const inactive = document.querySelector('.sp-carousel__item:not(.is-active)');
    expect(inactive?.hasAttribute('aria-hidden')).toBe(false);
    expect(inactive?.hasAttribute('inert')).toBe(true);
  });

  it('swipes when the touch STARTS ON A CARD, not on the track', async () => {
    /* The real gesture never begins on the track: a finger lands on a card.
       Those cards also run their own onTouchStart (the press-and-hold context
       menu) which calls e.stopPropagation(), so this asserts the carousel
       still sees the gesture. It does because the carousel binds a NATIVE
       listener on the track, which runs during the bubble phase before React's
       delegated handler at the root ever gets the chance to stop anything.
       Dispatching on the track, as the other tests do, would never catch a
       regression here. */
    renderCarousel();
    const card = document.querySelector('.sp-carousel__item.is-active') as HTMLElement;
    expect(card, 'no card to start the touch on').not.toBeNull();

    const touch = (x: number) => ({ clientX: x, clientY: 0 }) as Touch;
    await act(async () => {
      card.dispatchEvent(
        new TouchEvent('touchstart', { touches: [touch(0)] as unknown as Touch[], bubbles: true })
      );
    });
    for (let i = 1; i <= 10; i++) {
      await act(async () => {
        vi.advanceTimersByTime(400);
        card.dispatchEvent(
          new TouchEvent('touchmove', {
            touches: [touch((-333 * i) / 10)] as unknown as Touch[],
            bubbles: true,
            cancelable: true,
          })
        );
      });
    }
    await act(async () => {
      card.dispatchEvent(new TouchEvent('touchend', { bubbles: true }));
    });
    await settle();

    expect(activeName(), 'a touch starting on a card did not move the carousel').toBe('Bravo');
  });

  it('does NOT open a club when the gesture was a swipe', async () => {
    const onSelect = vi.fn();
    renderCarousel(onSelect);
    await swipe(-400);
    // The pointer travelled well past the 10px click slop, so the release is a
    // swipe. Without this rule, every swipe would also open whatever card the
    // finger happened to lift over.
    await act(async () => {
      (document.querySelector('.sp-carousel__item.is-active') as HTMLElement).click();
    });
    expect(onSelect).not.toHaveBeenCalled();
  });
});
