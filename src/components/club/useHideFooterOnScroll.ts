/**
 * THE FOOTER GETS OUT OF THE WAY WHILE YOU READ (Dan, 2026-09-04, binding).
 *
 * Dan, verbatim: "any other pages that you can 'scroll up to see more' need
 * this same disappearing footer functionality... check all the pages and sub
 * pages globally inside the world hub and for the club arena and implement
 * this everywhere its needed."
 *
 * It is Facebook's rule: travelling down the page drops the bar, travelling
 * back up brings it straight back. There is no route list, because none is
 * needed — a page that does not scroll never fires a scroll event, so its
 * footer never moves.
 *
 * "REAL TIME INSTANT CHANGE" IS PART OF THE REQUIREMENT. Nothing here eases,
 * delays, or waits on a timer: the caller applies a transform on the animation
 * frame following the scroll event, which is the frame the browser was going
 * to paint anyway. Do not add a CSS transition to smooth it out — smooth is
 * what Dan rejected.
 *
 * This is the twin of `useHideOnScroll` in the World Hub's BottomNavBar.jsx.
 * The two apps have to feel like one product, so if the behaviour changes in
 * one it changes in both.
 */
import { useCallback, useEffect, useState } from 'react';

/**
 * Pixels of travel in one direction before the bar flips. Measured from where
 * the current run began, not from the previous event, so a single fast flick
 * still flips immediately while sub-pixel jitter inside a momentum scroll
 * cannot rattle the bar open and shut.
 */
const THRESHOLD = 4;

type ScrollSource = EventTarget | null;

function isDocumentScroller(source: ScrollSource): boolean {
  return (
    !source ||
    source === window ||
    source === document ||
    source === document.documentElement ||
    source === document.body
  );
}

function scrollTopOf(source: ScrollSource): number {
  if (isDocumentScroller(source)) {
    return window.scrollY || document.documentElement?.scrollTop || document.body?.scrollTop || 0;
  }
  return (source as Element).scrollTop || 0;
}

function scrollLimitOf(source: ScrollSource): number {
  if (isDocumentScroller(source)) {
    const doc = document.documentElement;
    return doc ? Math.max(0, doc.scrollHeight - window.innerHeight) : 0;
  }
  const element = source as Element;
  return Math.max(0, (element.scrollHeight || 0) - (element.clientHeight || 0));
}

interface Travel {
  last: number;
  anchor: number;
  direction: number;
}

export interface HideOnScroll {
  hidden: boolean;
  reveal: () => void;
}

/**
 * @param resetKey Something that changes when the reader is handed a fresh
 *   screen — the pathname. Without it, arriving at a new page from a scrolled
 *   one inherits the hidden state and the footer looks broken until you scroll.
 */
export function useHideFooterOnScroll(resetKey: string): HideOnScroll {
  const [hidden, setHidden] = useState(false);
  const reveal = useCallback(() => setHidden(false), []);

  useEffect(() => {
    setHidden(false);
  }, [resetKey]);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;

    // Several Club Arena pages scroll an inner panel rather than the document,
    // and a scroll event on an element does not bubble — so this listens on
    // the CAPTURE phase at the document, which sees a scroll from any scroller
    // on the page, and tracks each one separately so switching between two
    // panels cannot read as a jump.
    const travel = new Map<ScrollSource, Travel>();
    let frame = 0;
    let pending: ScrollSource = null;

    const settle = () => {
      frame = 0;
      const source = pending;
      pending = null;

      const y = scrollTopOf(source);
      const state = travel.get(source);
      if (!state) {
        travel.set(source, { last: y, anchor: y, direction: 0 });
        return;
      }

      const direction = y > state.last ? 1 : y < state.last ? -1 : 0;
      if (direction !== 0 && direction !== state.direction) {
        state.anchor = state.last;
        state.direction = direction;
      }
      const anchor = state.anchor;
      state.last = y;

      // At the top of the page the bar is always present.
      if (y <= 0) {
        setHidden(false);
        return;
      }
      // Rubber-band overscroll past the end is not a reader travelling further
      // down, so it must not hide anything.
      if (y >= scrollLimitOf(source)) return;

      if (direction === 1 && y - anchor > THRESHOLD) setHidden(true);
      else if (direction === -1 && anchor - y > THRESHOLD) setHidden(false);
    };

    const onScroll = (event: Event) => {
      pending = event.target;
      if (frame) return;
      frame = window.requestAnimationFrame(settle);
    };

    document.addEventListener('scroll', onScroll, { capture: true, passive: true });
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      document.removeEventListener('scroll', onScroll, { capture: true });
      travel.clear();
    };
  }, []);

  return { hidden, reveal };
}
