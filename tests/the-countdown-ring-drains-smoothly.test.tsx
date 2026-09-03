/**
 * THE RING DRAINS, IT DOES NOT JUMP.
 *
 * Dan, 2026-09-03: "the disappearing blue timer is not disappearing smoothly
 * like it used to. It's disappearing in chunks, instead of a smooth consistent
 * disappearing bar."
 *
 * The ring is a pure-CSS `@property` animation on --timer-progress, and its
 * position on the timeline is set by `animation-delay` (--sp-timer-delay).
 * `animation-delay` is NOT ignored by a running animation: changing it
 * RE-TIMES the animation to a new offset. That variable was recomputed from a
 * live clock read on EVERY render, so every re-render of the seat - a stack
 * change, a pot change, any per-second tick above - snapped the arc to a
 * freshly quantised position instead of letting the compositor interpolate.
 * Hence chunks.
 *
 * SeatSlot already froze `holoDelayMs` once per turn for exactly this reason
 * ("feeding it a value that shrinks on every countdown tick would re-time a
 * running animation") - the timer delay was the one that got away.
 *
 * The law: within ONE turn, the timing variables handed to CSS must not change
 * as the clock advances. A NEW turn must still restart the ring.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import SeatSlot from '../src/components/table/SeatSlot';

const NOW = new Date('2026-09-03T00:00:00Z').getTime();

const player = {
  id: 'p1',
  name: 'HERO',
  stack: 1000,
  status: 'active' as const,
  showCards: false,
  isHero: true,
};

function seatProps(extra: Record<string, unknown>) {
  return {
    seatNumber: 1,
    player,
    position: 'BTN' as never,
    isActive: true,
    lastAction: null as never,
    ...extra,
  };
}

const info = (c: HTMLElement) => c.querySelector('.seat__info') as HTMLElement;
const timing = (el: HTMLElement) => ({
  delay: el.style.getPropertyValue('--sp-timer-delay'),
  duration: el.style.getPropertyValue('--sp-timer-duration'),
  flashDelay: el.style.getPropertyValue('--sp-timer-flash-delay'),
});

describe('the countdown ring drains smoothly', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it('does not re-time the animation as the clock advances within one turn', () => {
    const props = seatProps({ turnStartTimeMs: NOW, turnDeadlineMs: NOW + 15_000 });
    const { container, rerender } = render(<SeatSlot {...(props as never)} />);
    const first = timing(info(container));

    // Four seconds pass and the seat re-renders (a stack change, a pot change,
    // a per-second tick). This is the exact motion that used to make it jump.
    vi.setSystemTime(NOW + 4_000);
    rerender(
      <SeatSlot {...(seatProps({ ...props, player: { ...player, stack: 900 } }) as never)} />
    );
    const later = timing(info(container));

    expect(later.delay).toBe(first.delay);
    expect(later.duration).toBe(first.duration);
    expect(later.flashDelay).toBe(first.flashDelay);
  });

  it('is stable across many re-renders spread over the whole turn', () => {
    const props = seatProps({ turnStartTimeMs: NOW, turnDeadlineMs: NOW + 15_000 });
    const { container, rerender } = render(<SeatSlot {...(props as never)} />);
    const first = timing(info(container));
    const seen = new Set<string>();
    for (let t = 500; t <= 14_000; t += 500) {
      vi.setSystemTime(NOW + t);
      rerender(
        <SeatSlot {...(seatProps({ ...props, player: { ...player, stack: 1000 - t } }) as never)} />
      );
      seen.add(timing(info(container)).delay);
    }
    // ONE value for the whole turn: the animation was never re-timed.
    expect([...seen]).toEqual([first.delay]);
  });

  it('a NEW turn still restarts the ring from the top', () => {
    const props = seatProps({ turnStartTimeMs: NOW, turnDeadlineMs: NOW + 15_000 });
    const { container, rerender } = render(<SeatSlot {...(props as never)} />);
    expect(parseFloat(timing(info(container)).delay)).toBeCloseTo(0, 2);

    // Hero acts; some time later it is hero's turn again.
    vi.setSystemTime(NOW + 30_000);
    rerender(
      <SeatSlot
        {...(seatProps({ turnStartTimeMs: NOW + 30_000, turnDeadlineMs: NOW + 45_000 }) as never)}
      />
    );
    const fresh = timing(info(container));
    expect(parseFloat(fresh.delay)).toBeCloseTo(0, 2);
    expect(parseFloat(fresh.duration)).toBe(15);
  });

  it('a mid-turn rejoin picks the ring up where the turn actually is', () => {
    // First paint six seconds into somebody else's already-running turn: the
    // ring must start six seconds down, not restart. (The frozen origin is
    // what this turn's first paint saw - that is the point of freezing it.)
    vi.setSystemTime(NOW + 6_000);
    const { container } = render(
      <SeatSlot {...(seatProps({ turnStartTimeMs: NOW, turnDeadlineMs: NOW + 15_000 }) as never)} />
    );
    expect(parseFloat(timing(info(container)).delay)).toBeLessThan(0);
  });
});
