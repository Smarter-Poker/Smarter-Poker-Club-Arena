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

import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';

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

/**
 * jsdom has no layout, and BOTH the gesture and the one-time demo measure the
 * card before they will run. Stubbing the prototype (rather than the rendered
 * nodes) is what puts a rectangle in place BEFORE the mount effect reads one.
 */
const realRect = Element.prototype.getBoundingClientRect;
beforeEach(() => {
  Element.prototype.getBoundingClientRect = function (this: Element) {
    if (this.classList?.contains('seat__card--squeeze')) {
      return { left: 100, top: 200, width: W, height: H, right: 150, bottom: 270 } as DOMRect;
    }
    return realRect.call(this);
  };
  haptics.length = 0;
  sounds.length = 0;
  // Most suites here are about the gesture, not the one-time demo: mark it
  // seen so the coach mark is not in the way. The tutorial suite clears it.
  localStorage.setItem('ca_card_slide_tutorial_v1', '1');
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) =>
    window.setTimeout(() => cb(performance.now()), 16)
  );
  vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id));
});
afterEach(() => {
  Element.prototype.getBoundingClientRect = realRect;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('touching the cards picks them up', () => {
  it('a finger down marks the row peeling and starts flat', () => {
    const { row, card } = renderHero();
    pointer(card, 'pointerdown', 25, 64);
    expect(row.hasAttribute('data-peeling')).toBe(true);
    expect(progressOf(row)).toBe(0);
    expect(haptics).toEqual(['light']);
  });
});

describe('the pair tips up and the face arrives from the top', () => {
  /*
   * Dan 2026-09-05, from his own video with real cards: he tips the pair
   * toward himself on the near edge and the face comes into view from the TOP
   * DOWN - indices first, right way up. Dragging is VERTICAL. Two earlier
   * models are pinned against here because both shipped: a diagonal corner
   * curl, and a horizontal boundary running the wrong way (face revealed
   * bottom-up), which is what "the cards are still backwards" meant.
   */
  it('dragging UP reveals the face from the BOTTOM, and the two clips meet', () => {
    const { row, card } = renderHero();
    pointer(card, 'pointerdown', 25, 64);
    pointer(row, 'pointermove', 25, 64 - H / 2); // half a card of lift
    expect(progressOf(row)).toBeCloseTo(0.5, 2);
    expect(row.style.getPropertyValue('--peel-back-clip')).toBe('inset(0 0 50% 0)');
    expect(row.style.getPropertyValue('--peel-face-clip')).toBe('inset(50% 0 0 0)');
    expect(row.style.getPropertyValue('--peel-fold')).toBe('50%');
  });

  it('a small lift shows the BOTTOM sliver of the face', () => {
    const { row, card } = renderHero();
    pointer(card, 'pointerdown', 25, 64);
    pointer(row, 'pointermove', 25, 64 - H * 0.15);
    // Face keeps its bottom 15%; the back keeps everything above that line.
    expect(row.style.getPropertyValue('--peel-face-clip')).toBe('inset(85% 0 0 0)');
    expect(row.style.getPropertyValue('--peel-back-clip')).toBe('inset(0 0 15% 0)');
    // Named against v3, which shipped the mirror of this and passed every
    // structural check in the file.
    expect(row.style.getPropertyValue('--peel-face-clip')).not.toBe('inset(0 0 85% 0)');
  });

  it('dragging DOWN does not peel - the card just stays on the felt', () => {
    const { row, card } = renderHero();
    pointer(card, 'pointerdown', 25, 30);
    pointer(row, 'pointermove', 25, 60); // downward
    expect(progressOf(row)).toBe(0);
  });

  it('writes the geometry as CSS variables, without re-rendering the seat', () => {
    const { row, card } = renderHero();
    pointer(card, 'pointerdown', 25, 64);
    const before = row.outerHTML.length;
    pointer(row, 'pointermove', 25, 34);
    expect(progressOf(row)).toBeGreaterThan(0);
    expect(row.querySelectorAll('.seat__peel-crease').length).toBe(2);
    expect(Math.abs(row.outerHTML.length - before)).toBeLessThan(600);
  });

  it('both cards peel together from one set of variables on the row', () => {
    const { row, card } = renderHero();
    pointer(card, 'pointerdown', 25, 64);
    pointer(row, 'pointermove', 25, 34);
    expect(row.querySelectorAll('.seat__card--squeeze').length).toBe(2);
    expect(row.style.getPropertyValue('--peel-face-clip')).toMatch(/^inset\(/);
  });

  it('grips as the card leaves the felt and again at the commit line', () => {
    const { row, card } = renderHero();
    pointer(card, 'pointerdown', 25, 68);
    pointer(row, 'pointermove', 25, 63);
    pointer(row, 'pointermove', 25, 68 - H); // all the way open
    expect(haptics[0]).toBe('light');
    expect(haptics).toContain('medium');
  });
});

describe('letting go', () => {
  it('early: the corner settles back flat and the hand stays face down', () => {
    const { row, card, container } = renderHero();
    pointer(card, 'pointerdown', 25, 64);
    pointer(row, 'pointermove', 25, 54); // a short lift, under the threshold
    expect(progressOf(row)).toBeGreaterThan(0);
    expect(progressOf(row)).toBeLessThan(0.9);
    pointer(row, 'pointerup', 25, 54);
    expect(row.hasAttribute('data-peeling')).toBe(false);
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(row.style.getPropertyValue('--peel-progress')).toBe('');
    expect(container.querySelector('.seat__cards--squeeze')).toBeTruthy();
    expect(container.querySelector('.seat__cards--squeeze-open')).toBeNull();
    expect(sounds).not.toContain('playCardSqueeze');
  });

  it('peeled ALL THE WAY open: the hand opens and stays up', () => {
    /* RAISED 0.45 -> 0.9 on 2026-09-05. Dan: "YOU SHOULD ALSO BE ABLE TO PEEL
       THEM ALL THE WAY OPEN. WHEN THAT HAPPENS THEY STAY UP AND LIVE." At 0.45
       a glance committed the hand, so you could not look without turning the
       cards over - the opposite of what a peek is for. A HALF peel now settles
       back down; only a full one latches. */
    const { row, card, container } = renderHero();
    pointer(card, 'pointerdown', 25, 68);
    pointer(row, 'pointermove', 25, 40);
    pointer(row, 'pointermove', 25, 68 - H); // all the way
    expect(progressOf(row)).toBeGreaterThanOrEqual(0.9);
    pointer(row, 'pointerup', 25, 68 - H);
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(container.querySelector('.seat__cards--squeeze')).toBeNull();
    expect(container.querySelector('.seat__cards--squeeze-open')).toBeTruthy();
    // SILENT (Dan 2026-09-05): the peel makes no sound at all now, on the
    // way up or when it opens. Haptics are the only feedback.
    expect(sounds).toEqual([]);
  });

  it('a cancelled pointer drops the corner too', () => {
    const { row, card } = renderHero();
    pointer(card, 'pointerdown', 25, 64);
    pointer(row, 'pointermove', 25, 54);
    pointer(row, 'pointercancel', 25, 54);
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
    pointer(card, 'pointerdown', 25, 64);
    pointer(row, 'pointerup', 25, 64);
    expect(container.querySelector('.seat__cards--squeeze-hint')).toBeTruthy();
    expect(container.querySelector('.seat__cards--squeeze')).toBeTruthy();
    expect(sounds).not.toContain('playCardSqueeze');
  });

  it('a second tap is still not a reveal', () => {
    const { row, card, container } = renderHero();
    pointer(card, 'pointerdown', 25, 64);
    pointer(row, 'pointerup', 25, 64);
    act(() => {
      vi.advanceTimersByTime(100);
    });
    pointer(card, 'pointerdown', 25, 64);
    pointer(row, 'pointerup', 25, 64);
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
    pointer(row, 'pointermove', 90, 64 - H); // all the way open, past the commit line
    pointer(row, 'pointerup', 90, 64 - H);
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

describe('the tutorial teaches the gesture once', () => {
  it('runs on the first face-down hand and says what to do', () => {
    localStorage.clear();
    const { container } = renderHero();
    expect(container.querySelector('.seat__peel-coach')?.textContent).toBe(
      'Slide The Corner To Look'
    );
  });

  it('never runs again once it has been seen', () => {
    localStorage.clear();
    const first = renderHero();
    act(() => {
      vi.advanceTimersByTime(6000);
    });
    first.unmount();
    const { container } = renderHero();
    expect(container.querySelector('.seat__peel-coach')).toBeNull();
  });

  it('a real touch outranks the demonstration', () => {
    localStorage.clear();
    const { container, card, row } = renderHero();
    expect(container.querySelector('.seat__peel-coach')).toBeTruthy();
    pointer(card, 'pointerdown', 25, 64);
    expect(container.querySelector('.seat__peel-coach')).toBeNull();
    // ...and the peel that interrupted it still works.
    pointer(row, 'pointermove', 25, 30);
    expect(progressOf(row)).toBeGreaterThan(0);
  });

  it('waits for a background tab to be looked at before spending its one showing', () => {
    localStorage.clear();
    const spy = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    try {
      const { container, row } = renderHero();
      expect(container.querySelector('.seat__peel-coach')).toBeNull();
      // Nothing is left welded to the row either.
      expect(row.hasAttribute('data-peeling')).toBe(false);
      expect(localStorage.getItem('ca_card_slide_tutorial_v1')).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it('ends even if no animation frame ever arrives', () => {
    localStorage.clear();
    // A tab backgrounded mid-demo stops delivering frames. Without the timer
    // backstop the caption would stay up for the rest of the session.
    vi.stubGlobal('requestAnimationFrame', () => 1);
    const { container, row } = renderHero();
    expect(container.querySelector('.seat__peel-coach')).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(8000);
    });
    expect(container.querySelector('.seat__peel-coach')).toBeNull();
    expect(row.hasAttribute('data-peeling')).toBe(false);
    expect(localStorage.getItem('ca_card_slide_tutorial_v1')).toBe('1');
  });

  it('does not run when Card Slide is off', () => {
    localStorage.clear();
    const { container } = renderHero({ cardSqueezeActive: false });
    expect(container.querySelector('.seat__peel-coach')).toBeNull();
  });
});

describe('the peel is silent', () => {
  /*
   * Dan 2026-09-05: "remove the sound effect when you actually peel your card,
   * its not needed." The friction voice and the paper tick are gone, and so is
   * the open cue - which also deletes the whole class of bug the previous
   * version had, where a looping noise source could outlive its gesture.
   */
  it('makes no sound on touch, on drag, or on opening', () => {
    const { row, card } = renderHero();
    pointer(card, 'pointerdown', 25, 68);
    pointer(row, 'pointermove', 25, 40);
    pointer(row, 'pointermove', 25, 8);
    pointer(row, 'pointerup', 25, 8);
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(sounds).toEqual([]);
  });

  it('but still buzzes - the haptic is the feedback that stayed', () => {
    const { row, card } = renderHero();
    pointer(card, 'pointerdown', 25, 68);
    pointer(row, 'pointermove', 25, 30);
    expect(haptics.length).toBeGreaterThan(0);
  });
});

describe('the tutorial teaches the gesture once', () => {
  it('runs on the first face-down hand and says what to do', () => {
    localStorage.clear();
    const { container } = renderHero();
    expect(container.querySelector('.seat__peel-coach')?.textContent).toBe(
      'Slide The Corner To Look'
    );
  });

  it('never runs again once it has been seen', () => {
    localStorage.clear();
    const first = renderHero();
    act(() => {
      vi.advanceTimersByTime(6000);
    });
    first.unmount();
    const { container } = renderHero();
    expect(container.querySelector('.seat__peel-coach')).toBeNull();
  });

  it('a real touch outranks the demonstration', () => {
    localStorage.clear();
    const { container, card, row } = renderHero();
    expect(container.querySelector('.seat__peel-coach')).toBeTruthy();
    pointer(card, 'pointerdown', 25, 64);
    expect(container.querySelector('.seat__peel-coach')).toBeNull();
    // ...and the peel that interrupted it still works.
    pointer(row, 'pointermove', 25, 30);
    expect(progressOf(row)).toBeGreaterThan(0);
  });

  it('waits for a background tab to be looked at before spending its one showing', () => {
    localStorage.clear();
    const spy = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    try {
      const { container, row } = renderHero();
      expect(container.querySelector('.seat__peel-coach')).toBeNull();
      // Nothing is left welded to the row either.
      expect(row.hasAttribute('data-peeling')).toBe(false);
      expect(localStorage.getItem('ca_card_slide_tutorial_v1')).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it('ends even if no animation frame ever arrives', () => {
    localStorage.clear();
    // A tab backgrounded mid-demo stops delivering frames. Without the timer
    // backstop the caption would stay up for the rest of the session.
    vi.stubGlobal('requestAnimationFrame', () => 1);
    const { container, row } = renderHero();
    expect(container.querySelector('.seat__peel-coach')).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(8000);
    });
    expect(container.querySelector('.seat__peel-coach')).toBeNull();
    expect(row.hasAttribute('data-peeling')).toBe(false);
    expect(localStorage.getItem('ca_card_slide_tutorial_v1')).toBe('1');
  });

  it('does not run when Card Slide is off', () => {
    localStorage.clear();
    const { container } = renderHero({ cardSqueezeActive: false });
    expect(container.querySelector('.seat__peel-coach')).toBeNull();
  });
});

describe('the markup', () => {
  it('carries a face, a back and a crease per card', () => {
    const { container } = renderHero();
    for (const box of Array.from(container.querySelectorAll('.seat__card--squeeze'))) {
      expect(box.querySelector('.seat__squeeze-face--under')).toBeTruthy();
      expect(box.querySelector('.seat__squeeze-face--cover')).toBeTruthy();
      expect(box.querySelector('.seat__peel-crease')).toBeTruthy();
    }
  });

  it('is announced as a peel, not a drag-up', () => {
    const { row } = renderHero();
    expect(row.getAttribute('aria-label')).toMatch(/Peel/);
  });
});

/* ═════════════════════════════════════════════════════════════════════════
   THE BUGS FROM DAN'S SCREEN RECORDING, 2026-09-05 (SLIDE BUGS.MOV)
   ═════════════════════════════════════════════════════════════════════════ */

describe('a new hand is face down in its FIRST painted frame', () => {
  /*
   * Dan: "CARDS ARE FLASHED BEFORE YOU CAN PEEL THEM, THAT KINDA DEFEATS THE
   * PURPOSE OF THE PEEL."
   *
   * `squeezeRevealed` was state cleared by an effect keyed on handNumber, and
   * a passive effect runs AFTER the commit it belongs to - so the first commit
   * of the next hand still carried the previous hand's `true` and painted the
   * fresh hole cards FACE UP, with the hand-strength label, before flipping
   * them down. Visible in his recording at 4.6-5.2s: K-diamond / Q-heart,
   * "King High", then the backs.
   *
   * THIS TEST HAS TO SEE BETWEEN THE COMMIT AND THE EFFECT, so it cannot use
   * `act()` or RTL's `rerender` - both flush passive effects, which is exactly
   * what hid the bug. The first version of this test did, and passed against
   * the broken code. `flushSync` commits synchronously and leaves passive
   * effects scheduled, so the DOM read straight afterwards is the frame the
   * player actually saw.
   */
  const renderFrames = () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const paint = (handNumber: number, player: SeatPlayer = hero) =>
      flushSync(() => {
        root.render(
          <SeatSlot
            seatNumber={1}
            player={player}
            position={null}
            isActive={false}
            lastAction={null}
            cardSqueezeActive={true}
            handNumber={handNumber}
            playSounds={true}
            handStrength="Ace High"
          />
        );
      });
    return { host, root, paint };
  };

  it('does not flash the cards face up when the hand number advances', () => {
    const { host, root, paint } = renderFrames();
    paint(1);
    const row = host.querySelector('.seat__cards--squeeze') as HTMLElement;
    const card = host.querySelector('.seat__card--squeeze') as HTMLElement;

    // Open hand 1 all the way.
    pointer(card, 'pointerdown', 25, 68);
    pointer(row, 'pointermove', 25, 68 - H);
    pointer(row, 'pointerup', 25, 68 - H);
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(host.querySelector('.seat__cards--squeeze-open')).toBeTruthy();

    // Hand 2 arrives. Read the DOM with the effects still pending.
    paint(2);
    expect(host.querySelector('.seat__cards--squeeze')).toBeTruthy();
    expect(host.querySelector('.seat__cards--squeeze-open')).toBeNull();
    // The strength label is the tell in the video - it must not appear either.
    expect(host.querySelector('.seat__strength')).toBeNull();

    act(() => {
      root.unmount();
    });
    host.remove();
  });

  it('drops the open hand in the same frame the cards are taken away', () => {
    const { host, root, paint } = renderFrames();
    paint(1);
    const row = host.querySelector('.seat__cards--squeeze') as HTMLElement;
    const card = host.querySelector('.seat__card--squeeze') as HTMLElement;
    pointer(card, 'pointerdown', 25, 68);
    pointer(row, 'pointermove', 25, 68 - H);
    pointer(row, 'pointerup', 25, 68 - H);
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(host.querySelector('.seat__cards--squeeze-open')).toBeTruthy();

    paint(1, { ...hero, holeCards: [] } as SeatPlayer);
    expect(host.querySelector('.seat__cards--squeeze-open')).toBeNull();

    act(() => {
      root.unmount();
    });
    host.remove();
  });
});

describe('double tap holds a small lift', () => {
  /*
   * Dan: "OR DOUBLE TAP, THAT LIFTS THEM SLIGHTLY (LIKE IN THE REAL VIDEO I
   * SENT YOU)." A held look, so you can read the cards without keeping a
   * finger on them, and without committing the hand.
   */
  const tap = (row: HTMLElement, card: HTMLElement) => {
    pointer(card, 'pointerdown', 25, 64);
    pointer(row, 'pointerup', 25, 64);
  };

  it('two taps lift the pair and LEAVE it lifted', () => {
    const { row, card, container } = renderHero();
    tap(row, card);
    tap(row, card);
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(progressOf(row)).toBeGreaterThan(0);
    // Lifted, but NOT opened - the hand is still face down and still peelable.
    expect(container.querySelector('.seat__cards--squeeze')).toBeTruthy();
    expect(container.querySelector('.seat__cards--squeeze-open')).toBeNull();
  });

  it('two more taps put them back down', () => {
    const { row, card } = renderHero();
    tap(row, card);
    tap(row, card);
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(progressOf(row)).toBeGreaterThan(0);
    tap(row, card);
    tap(row, card);
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(progressOf(row)).toBe(0);
  });

  it('a single tap is still only a hint, never a lift', () => {
    const { row, card } = renderHero();
    tap(row, card);
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(progressOf(row)).toBe(0);
  });

  it('two taps far apart are two single taps, not a double', () => {
    const { row, card } = renderHero();
    tap(row, card);
    act(() => {
      vi.advanceTimersByTime(900); // well past DOUBLE_TAP_MS
    });
    tap(row, card);
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(progressOf(row)).toBe(0);
  });

  it('the held lift does not survive into the next hand', () => {
    const { row, card, container } = renderHero();
    tap(row, card);
    tap(row, card);
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(progressOf(row)).toBeGreaterThan(0);
    act(() => {
      container.remove();
    });
  });
});

describe('the show-card eye is never on a card you cannot click', () => {
  /*
   * Dan: "THE EYE BALL STAYS LOCKED, YOU CAN NEVER UNLOCK IT OR UNSHOW, AND IT
   * STAYS LOCKED FOR FUTURE HANDS AS WELL."
   *
   * `.seat__card-pick--marked` draws a gold eye on the card corner and was
   * applied with no reference to squeeze state, while BOTH of its handlers
   * early-return on `squeezeDown`. A pick that outlived its hand therefore sat
   * visibly on the back of a face-down card and did nothing when tapped.
   */
  it('is not drawn while the cards are face down', () => {
    const { container } = renderHero({ showPickedCardIndexes: [0], onToggleShowCard: () => {} });
    expect(container.querySelector('.seat__cards--squeeze')).toBeTruthy();
    expect(container.querySelector('.seat__card-pick--marked')).toBeNull();
  });

  it('is drawn once the hand is open, where the click works', () => {
    const { row, card, container } = renderHero({
      showPickedCardIndexes: [0],
      onToggleShowCard: () => {},
    });
    pointer(card, 'pointerdown', 25, 68);
    pointer(row, 'pointermove', 25, 68 - H);
    pointer(row, 'pointerup', 25, 68 - H);
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(container.querySelector('.seat__card-pick--marked')).toBeTruthy();
  });
});
