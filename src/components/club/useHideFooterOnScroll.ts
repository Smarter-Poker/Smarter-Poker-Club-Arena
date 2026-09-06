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
 *
 * ── HARDENED 2026-09-05 ────────────────────────────────────────────────────
 * Dan, the next day: "THE FOOTER IS NOT STAYING ON THE BOTTOM WHEN SCROLLING."
 *
 * Read against the rule above that is a contradiction, and it is not: the bar
 * was leaving when nobody had travelled anywhere. Three things did it, and all
 * three are fixed below without touching the behaviour Dan asked for.
 *
 *   1. FOUR PIXELS IS NOT TRAVEL. A momentum scroll settling, a rubber-band
 *      returning, an image loading and reflowing the column - all cleared a
 *      4px threshold. It is 24px now, about a line of text.
 *   2. A SMALL INNER LIST IS NOT THE PAGE. The capture-phase listener sees
 *      every scroller on the page, which is the point; but a 60px chat log or
 *      filter row scrolling was taking the global footer with it. A scroller
 *      must have somewhere to go (MIN_SCROLLER_RANGE) before it may hide it.
 *   3. THE BOTTOM OF A PAGE IS A DEAD END. At the end of the scroll there is
 *      nothing below to scroll back up from, so a footer hidden there stayed
 *      hidden. It comes back at the end now.
 *
 * None of this eases, delays or waits on a timer. The flip is still the frame
 * after the scroll event, which is the requirement.
 */
import { useCallback, useEffect, useState } from 'react';

/**
 * Pixels of travel in one direction before the bar flips. Measured from where
 * the current run began, not from the previous event, so a single fast flick
 * still flips immediately while sub-pixel jitter inside a momentum scroll
 * cannot rattle the bar open and shut.
 *
 * RAISED FROM 4 TO 24 (Dan 2026-09-05: "THE FOOTER IS NOT STAYING ON THE
 * BOTTOM WHEN SCROLLING"). Four pixels is not a reader travelling down the
 * page - it is a thumb resting on a momentum scroll, a rubber-band settling,
 * a focus ring nudging a field into view, an image finishing its load and
 * reflowing the column under you. Every one of those took the bar away, which
 * is what "not staying" is: the bar leaving when nobody asked it to. The
 * behaviour Dan asked for on 2026-09-04 is unchanged and still instant -
 * travelling down drops it, travelling back up brings it straight back - this
 * only decides what counts as travelling. 24px is about a line of text.
 */
const THRESHOLD = 24;

/**
 * A scroller has to be able to go somewhere before it may hide the global bar.
 *
 * The listener is on the document's CAPTURE phase so it sees a scroll from ANY
 * scroller on the page, which is what makes it work on the Club Arena pages
 * that scroll an inner panel. The cost is that it also sees every small inner
 * scroller: a chat log, a filter row, a scrollable card. Those are not the
 * reader travelling down the page, and taking the footer away because a
 * 60px-tall list moved is the second half of Dan's report.
 */
const MIN_SCROLLER_RANGE = 96;

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
      const limit = scrollLimitOf(source);

      /* Too small to be "the page". Tracked as nothing at all - not even an
         anchor - so a later, larger scroll from the same target starts clean. */
      if (limit < MIN_SCROLLER_RANGE) return;

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
      /* AND AT THE BOTTOM IT COMES BACK (Dan 2026-09-05). This used to return
         early here, on the reasoning that rubber-band overscroll past the end
         is not a reader travelling further down - true, and it still must not
         HIDE anything. But leaving it hidden is the state Dan can see and
         cannot get out of: you scroll to the end of a page, there is nothing
         below to reveal it with, and the footer is simply gone. There is
         nothing left to read down here, so there is nothing for the bar to be
         in the way of. The clearance below the content (--bottom-nav-clearance)
         is reserved whether the bar is up or not, so this covers nothing. */
      if (y >= limit) {
        setHidden(false);
        return;
      }

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
