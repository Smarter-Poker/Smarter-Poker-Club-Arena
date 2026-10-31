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

function contentHeightOf(source: ScrollSource): number {
  if (isDocumentScroller(source)) return document.documentElement?.scrollHeight || 0;
  return (source as Element).scrollHeight || 0;
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
  /** The scroller's content height at the last read; 0 until first read. */
  height: number;
  /** The visible panel also changes when the footer returns. */
  viewport: number;
  /** Keep the footer visible through the remainder of a bottom-edge flick. */
  endReached: boolean;
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
    let pendingInput = 0;
    const input = new Map<ScrollSource, number>();
    let inputFrame = 0;
    let touchY: number | null = null;

    const sourceOf = (target: ScrollSource): ScrollSource =>
      isDocumentScroller(target) ? document : target;
    const inputSourceOf = (target: EventTarget | null, direction: number): ScrollSource => {
      let element = target instanceof Element ? target : null;
      while (element && !isDocumentScroller(element)) {
        const limit = scrollLimitOf(element);
        const canTravel = direction < 0 ? element.scrollTop > 0 : element.scrollTop < limit - 1;
        if (/^(auto|scroll)$/.test(getComputedStyle(element).overflowY) && limit > 0 && canTravel)
          return element;
        element = element.parentElement;
      }
      return document;
    };
    const recordInput = (target: EventTarget | null, delta: number) => {
      if (!delta) return;
      input.set(inputSourceOf(target, Math.sign(delta)), Math.sign(delta));
      // Input is evidence only for scroll events from this browser frame.
      // Capture it in onScroll before clearing, so rAF callback order cannot
      // erase an actual scroll already waiting to settle.
      if (!inputFrame)
        inputFrame = window.requestAnimationFrame(() => {
          inputFrame = 0;
          input.clear();
        });
    };
    const onWheel = (event: WheelEvent) => recordInput(event.target, event.deltaY);
    const onTouchStart = (event: TouchEvent) => {
      touchY = event.touches[0]?.clientY ?? null;
    };
    const onTouchMove = (event: TouchEvent) => {
      const next = event.touches[0]?.clientY ?? null;
      if (next !== null && touchY !== null) recordInput(event.target, touchY - next);
      touchY = next;
    };
    const onTouchEnd = () => {
      touchY = null;
    };

    const settle = () => {
      frame = 0;
      const source = pending;
      pending = null;
      const inputDirection = pendingInput;
      pendingInput = 0;

      const y = scrollTopOf(source);
      const limit = scrollLimitOf(source);

      const viewport = isDocumentScroller(source)
        ? window.innerHeight
        : (source as Element).clientHeight;
      const state = travel.get(source) ?? {
        last: 0,
        anchor: 0,
        direction: 0,
        height: 0,
        viewport,
        endReached: false,
      };
      travel.set(source, state);
      const resized = state.viewport !== viewport;
      state.viewport = viewport;

      // A footer reveal shrinks TournamentDetails' panel by the footer's
      // height. Scroll anchoring/clamping from that resize is not a swipe.
      // Retain the sample even for a short range so its next resize cannot
      // restart direction detection from zero.
      if (limit < MIN_SCROLLER_RANGE || (resized && inputDirection === 0)) {
        state.last = y;
        state.anchor = y;
        state.direction = 0;
        state.height = contentHeightOf(source);
        if (limit < MIN_SCROLLER_RANGE || y >= limit - 1) {
          state.endReached = true;
          setHidden(false);
        }
        return;
      }

      /* THE PAGE MOVING IS NOT THE READER MOVING (2026-10-19). When content
         ABOVE the viewport changes height - the live lobby re-rendering a card
         as seats and counts refresh - the browser's scroll anchoring moves
         scrollY by exactly that change so the reader's place stays put, and
         fires a scroll event. A card that shrinks and is restored on the next
         render is an up-then-down pair nobody made, and the down leg cleared
         THRESHOLD: the footer and the lobby filters left while the player sat
         still (post-deploy runs 39232506260 and 39245711984 caught the bar and
         the filters hidden with scrollY unchanged). That is the same
         "leaving when nobody travelled" Dan reported on 2026-09-05. A scroll
         whose distance is the content's own change in height is the page
         keeping its place, not travel: rebase on it and decide nothing, except
         that the bottom still brings the bar back (a page that shrank under a
         reader at its end is clamped up to the new end). */
      const height = contentHeightOf(source);
      const previous = state.height;
      const moved = y - state.last;
      const grew = height - previous;
      state.height = height;
      // Matching geometry can also be real travel while a card below the
      // reader changes size. Same-frame wheel/touch input in the observed
      // direction distinguishes that travel from the page keeping its place.
      if (
        previous > 0 &&
        grew !== 0 &&
        moved !== 0 &&
        Math.abs(moved - grew) <= 1 &&
        Math.sign(moved) !== inputDirection
      ) {
        state.last = y;
        state.anchor = y;
        state.direction = 0;
        if (y >= limit - 1) {
          state.endReached = true;
          setHidden(false);
        }
        return;
      }

      // New content below the reader creates a genuinely new reading range.
      // An anchoring-only change already returned above; do not keep the old
      // end state when a filter/live update extends the list.
      if (previous > 0 && grew > 0) state.endReached = false;

      const direction = y > state.last ? 1 : y < state.last ? -1 : 0;
      if (direction !== 0 && direction !== state.direction) {
        state.anchor = state.last;
        state.direction = direction;
      }
      const anchor = state.anchor;
      state.last = y;

      // At the top of the page the bar is always present.
      if (y <= 0) {
        state.endReached = false;
        state.anchor = y;
        state.direction = 0;
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
      /* A PIXEL OF TOLERANCE (2026-09-06). `scrollY` is fractional and
         `scrollHeight` is an integer, so on a fractional-DPR or zoomed phone
         the true bottom is routinely `limit - 0.5` and an exact `>=` never
         fires - on precisely the class of device this reveal was written for. */
      if (y >= limit - 1) {
        state.endReached = true;
        state.anchor = y;
        state.direction = 0;
        setHidden(false);
        return;
      }

      // Reaching the end reveals the footer and creates new scroll range in
      // bounded panels. The same continuing touch momentum/wheel gesture must
      // not hide it in that new range, then clamp/reveal/hide it repeatedly.
      // Leave this state only after a real upward run away from the end.
      if (state.endReached) {
        if (direction === -1 && anchor - y > THRESHOLD) state.endReached = false;
        else return;
      }

      if (direction === 1 && y - anchor > THRESHOLD) setHidden(true);
      else if (direction === -1 && anchor - y > THRESHOLD) setHidden(false);
    };

    const onScroll = (event: Event) => {
      const source = sourceOf(event.target);
      if (source !== pending) pendingInput = 0;
      pending = source;
      pendingInput = input.get(source) ?? pendingInput;
      if (frame) return;
      frame = window.requestAnimationFrame(settle);
    };

    document.addEventListener('wheel', onWheel, {
      capture: true,
      passive: true,
    });
    document.addEventListener('touchstart', onTouchStart, {
      capture: true,
      passive: true,
    });
    document.addEventListener('touchmove', onTouchMove, {
      capture: true,
      passive: true,
    });
    document.addEventListener('touchend', onTouchEnd, true);
    document.addEventListener('touchcancel', onTouchEnd, true);
    document.addEventListener('scroll', onScroll, {
      capture: true,
      passive: true,
    });
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      if (inputFrame) window.cancelAnimationFrame(inputFrame);
      document.removeEventListener('wheel', onWheel, true);
      document.removeEventListener('touchstart', onTouchStart, true);
      document.removeEventListener('touchmove', onTouchMove, true);
      document.removeEventListener('touchend', onTouchEnd, true);
      document.removeEventListener('touchcancel', onTouchEnd, true);
      document.removeEventListener('scroll', onScroll, { capture: true });
      travel.clear();
    };
  }, []);

  return { hidden, reveal };
}
