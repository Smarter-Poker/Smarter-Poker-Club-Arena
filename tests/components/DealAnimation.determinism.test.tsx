/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE DEAL MUST FIRE, EVERY HAND
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-23: "THE CARD DEALING ANIMATION NEEDS TO FIRE AND WORK 100 PERCENT
 * OF THE TIME."
 *
 * Each case here is a hand that USED to lose its deal. The old component
 * scheduled the whole deal inside one `useEffect` keyed on
 * `[active, activeSeats.length]`, so React's cleanup ran mid-flight every time
 * the roster changed size and cancelled the deal's own timers; and it latched
 * "already dealt" even when it had produced zero cards, so a hand that started
 * before the seat geometry arrived never got a second chance.
 *
 * A failure in this file means a player watches cards appear out of nowhere, or
 * sits locked out of their turn behind an action hold that was never released.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import React from 'react';

// ── Sound spy ────────────────────────────────────────────────────────────────
const played: string[] = [];
vi.mock('../../src/services/SoundService', () => {
  const make =
    (name: string) =>
    (...a: unknown[]) => {
      played.push(name);
      void a;
    };
  const soundService = new Proxy(
    {
      isEnabled: () => true,
      // SOUND AUDIT 2026-08-27: the deal's slides are now scheduled in ONE
      // call on the AudioContext clock (playDealSequence) instead of one
      // setTimeout+playDeal per card — record one 'playDeal' per scheduled
      // slide so every per-card assertion below keeps meaning "a sound per
      // card dealt".
      playDealSequence: (delays: unknown) => {
        (Array.isArray(delays) ? delays : []).forEach(() => played.push('playDeal'));
      },
    } as Record<string, unknown>,
    {
      get(target, prop: string) {
        if (prop in target) return target[prop];
        return make(prop);
      },
    }
  );
  const haptic = new Proxy({} as Record<string, unknown>, {
    get: (_t, prop: string) => make(`haptic.${prop}`),
  });
  return { soundService, haptic, default: soundService };
});

import { DealAnimation } from '../../src/components/table/DealAnimation';

const POS = Array.from({ length: 9 }, (_, i) => ({ x: 10 + i * 9, y: 50 }));
const SIX = [0, 1, 2, 3, 4, 5];
const NINE = [0, 1, 2, 3, 4, 5, 6, 7, 8];

/** The engine's inter-hand gap on a fold-win (TablePage HAND_STARTED handler). */
const INTER_HAND_GAP_MS = 2000;
/** SoundService.shouldPlay drops a same-rank sound inside this window. */
const SOUND_PRIORITY_WINDOW_MS = 50;

const dealCards = (c: HTMLElement) => c.querySelectorAll('.deal-animation__card');
const dealSounds = () => played.filter((p) => p === 'playDeal').length;

beforeEach(() => {
  played.length = 0;
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('a roster change mid-deal cannot cancel the deal', () => {
  it('finishes all twelve cards and their sounds when a seat sits out mid-flight', () => {
    const onComplete = vi.fn();
    const { container, rerender } = render(
      <DealAnimation
        active
        activeSeats={SIX}
        dealerSeatIndex={0}
        seatPositions={POS}
        onComplete={onComplete}
      />
    );
    expect(dealCards(container).length).toBe(12);

    act(() => {
      vi.advanceTimersByTime(120);
    });
    // The fresh snapshot lands AFTER the hand-start event -- this is the common
    // ordering, not an edge case -- and it has one fewer live seat.
    rerender(
      <DealAnimation
        active
        activeSeats={[0, 1, 2, 3, 4]}
        dealerSeatIndex={0}
        seatPositions={POS}
        onComplete={onComplete}
      />
    );
    act(() => {
      vi.advanceTimersByTime(3000);
    });

    // Twelve cards were launched, so twelve cards must be heard. The old
    // component stopped at two.
    expect(dealSounds()).toBe(12);
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(dealCards(container).length).toBe(0);
  });

  it('does not restart the deal when the roster grows mid-flight', () => {
    const { container, rerender } = render(
      <DealAnimation active activeSeats={SIX} dealerSeatIndex={0} seatPositions={POS} />
    );
    act(() => {
      vi.advanceTimersByTime(150);
    });
    rerender(
      <DealAnimation active activeSeats={[...SIX, 6]} dealerSeatIndex={0} seatPositions={POS} />
    );
    // Still the SAME twelve cards -- a player joining must not re-deal the hand.
    expect(dealCards(container).length).toBe(12);
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(dealSounds()).toBe(12);
  });
});

describe('a hand that starts before the table geometry arrives still deals', () => {
  it('deals on the render that brings the seat positions', () => {
    const onComplete = vi.fn();
    const { container, rerender } = render(
      <DealAnimation
        active
        activeSeats={[0, 1, 2]}
        dealerSeatIndex={0}
        seatPositions={[]}
        onComplete={onComplete}
      />
    );
    // Nothing yet, and crucially nothing LATCHED.
    expect(dealCards(container).length).toBe(0);
    expect(onComplete).not.toHaveBeenCalled();

    rerender(
      <DealAnimation
        active
        activeSeats={[0, 1, 2]}
        dealerSeatIndex={0}
        seatPositions={POS}
        onComplete={onComplete}
      />
    );
    expect(dealCards(container).length).toBe(6);
  });

  it('recovers on its own timer even if the parent never re-renders', () => {
    // The roster array identity is what TablePage hands over; mutating it here
    // simulates late data arriving with no React render to announce it.
    const lateSeats: number[] = [];
    const { container } = render(
      <DealAnimation active activeSeats={lateSeats} dealerSeatIndex={0} seatPositions={POS} />
    );
    expect(dealCards(container).length).toBe(0);
    lateSeats.push(0, 1, 2, 3);
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(dealCards(container).length).toBe(8);
  });

  it('releases the action hold even when the seats never arrive at all', () => {
    // TablePage gates the action panel on onComplete. A missing animation is
    // survivable; a player frozen out of their own turn is not.
    const onComplete = vi.fn();
    const { container } = render(
      <DealAnimation
        active
        activeSeats={[]}
        dealerSeatIndex={0}
        seatPositions={[]}
        onComplete={onComplete}
      />
    );
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(dealCards(container).length).toBe(0);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });
});

describe('a second hand on the same mounted instance', () => {
  it('builds new elements so the finished CSS animation cannot be reused', () => {
    const { container, rerender } = render(
      <DealAnimation
        active
        activeSeats={SIX}
        dealerSeatIndex={0}
        seatPositions={POS}
        dealKey={101}
      />
    );
    const firstHandNodes = Array.from(dealCards(container));
    expect(firstHandNodes.length).toBe(12);
    act(() => {
      vi.advanceTimersByTime(3000);
    });

    rerender(
      <DealAnimation
        active
        activeSeats={SIX}
        dealerSeatIndex={1}
        seatPositions={POS}
        dealKey={102}
      />
    );
    const secondHandNodes = Array.from(dealCards(container));
    expect(secondHandNodes.length).toBe(12);
    // An element that already ran `dealFly` will not run it again. Only a fresh
    // node replays, which is why the run id is part of the React key.
    secondHandNodes.forEach((node) => expect(firstHandNodes).not.toContain(node));
  });
});

describe('the deal always fits between two hands', () => {
  it('a nine-handed deal completes inside the engine inter-hand gap', () => {
    const onComplete = vi.fn();
    render(
      <DealAnimation
        active
        activeSeats={NINE}
        dealerSeatIndex={4}
        seatPositions={POS}
        onComplete={onComplete}
      />
    );
    act(() => {
      vi.advanceTimersByTime(INTER_HAND_GAP_MS - 1);
    });
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(dealSounds()).toBe(18);
  });

  it('never staggers cards closer than the sound priority window', () => {
    // Two `deal` sounds inside 50ms and the second is dropped by
    // SoundService.shouldPlay, so the player hears half a deal.
    const { container } = render(
      <DealAnimation active activeSeats={NINE} dealerSeatIndex={0} seatPositions={POS} />
    );
    const delays = Array.from(dealCards(container)).map((el) =>
      parseInt((el as HTMLElement).style.getPropertyValue('--delay'), 10)
    );
    for (let i = 1; i < delays.length; i++) {
      expect(delays[i] - delays[i - 1]).toBeGreaterThan(SOUND_PRIORITY_WINDOW_MS);
    }
  });
});

describe('onComplete is fired once and only once', () => {
  it('does not fire again after the layer has cleaned itself up', () => {
    const onComplete = vi.fn();
    render(
      <DealAnimation
        active
        activeSeats={SIX}
        dealerSeatIndex={0}
        seatPositions={POS}
        onComplete={onComplete}
      />
    );
    act(() => {
      vi.advanceTimersByTime(10000);
    });
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('does not fire from a table that was closed mid-deal', () => {
    const onComplete = vi.fn();
    const { unmount } = render(
      <DealAnimation
        active
        activeSeats={SIX}
        dealerSeatIndex={0}
        seatPositions={POS}
        onComplete={onComplete}
      />
    );
    act(() => {
      vi.advanceTimersByTime(100);
    });
    unmount();
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(onComplete).not.toHaveBeenCalled();
  });
});
