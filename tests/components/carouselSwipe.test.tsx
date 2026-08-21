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

function renderCarousel(onSelect?: (v: string, i: number) => void) {
  return render(
    <Carousel
      items={CLUBS}
      getKey={(c) => c}
      itemWidth={300}
      onSelect={onSelect}
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
      (screen.getByText('Alpha').closest('.sp-carousel__item') as HTMLElement).click();
    });
    expect(onSelect).toHaveBeenCalledWith('Alpha', 0);
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
