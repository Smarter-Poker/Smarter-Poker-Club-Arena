/**
 * THE FILTERS GET OUT OF THE WAY WHILE YOU READ (Dan, 2026-10-11).
 *
 * Dan, verbatim: "GAME Filters INSIDE OF THE CLUB need to work like the footer
 * but in reverse. When they hit the top of the page when scrolling down they
 * should 'disappear' but when you scroll back up, they should re appear."
 *
 * The Find Your Game deck and the sort row under it are sticky under the
 * global header (ClubLobbyCommandTop.css MOBILE FIND-YOUR-GAME LOCK and
 * LobbySortBar.css). On a phone, stuck together, they cover most of the
 * screen and the game cards scroll underneath them.
 *
 * THE DIRECTION RULE IS THE FOOTER'S, NOT A COPY OF IT. `useHideFooterOnScroll`
 * decides when the reader is travelling down or back up - the same capture
 * phase listener, the same 24px of travel, the same "always present at the top"
 * and "comes back at the bottom" - so the deck and the footer leave and return
 * on the same frame. If that rule changes, both change. This hook adds only the
 * three things the footer has no use for:
 *
 *   1. STUCK. The deck only leaves once it has reached its pinned place under
 *      the header. Before that it is just part of the page, scrolling with it.
 *      On a desktop the deck sits above a cabinet that never scrolls (the game
 *      table scrolls inside it), so it is never stuck there and never leaves;
 *      it only does when a new club's opening checklist makes the cabinet
 *      itself the scrollport.
 *   2. IN USE. A Stakes or Variant menu open on the sort row, a create menu
 *      open on the deck, or a finger down on either keeps them where they are.
 *      The caller adds the Filters sheet (`hold`), which is not inside either.
 *   3. FOCUS. Tabbing into a deck that scroll has parked out of sight brings it
 *      back, the same promise the footer's onFocusCapture makes.
 */
import { useEffect, useState, type RefObject } from 'react';
import { useHideFooterOnScroll } from '../club/useHideFooterOnScroll';

/** The sort row is rendered by LobbyTable, a sibling subtree in the same cabinet. */
function sortbarOf(deck: HTMLElement): HTMLElement | null {
  return deck.closest('.club-lobby-machine')?.querySelector<HTMLElement>('.lobby-sortbar') ?? null;
}

function isDocument(el: Element): boolean {
  return el === document.documentElement || el === document.body;
}

/**
 * The box a sticky element pins against: its nearest scroll container, or the
 * page. `clip` is not a scroll container (ClubHomePage.css relies on exactly
 * that), and a `display: contents` wrapper has no box at all - the command
 * wrapper is one on every width, and still computes `overflow: hidden` on a
 * phone, so reading its overflow would pin the deck to a box that never moves.
 */
function scrollportOf(el: HTMLElement): HTMLElement | null {
  const scrolls = /^(auto|scroll|hidden)$/;
  let next = el.parentElement;
  while (next && !isDocument(next)) {
    const style = getComputedStyle(next);
    if (
      style.display !== 'contents' &&
      (scrolls.test(style.overflowY) || scrolls.test(style.overflowX))
    ) {
      return next;
    }
    next = next.parentElement;
  }
  return null;
}

/** The translateY a transform is applying right now - mid-transition included. */
export function translateYOf(transform: string | null | undefined): number {
  if (!transform || transform === 'none') return 0;
  const values = transform.match(/matrix(3d)?\(([^)]*)\)/);
  if (!values) return 0;
  const parts = values[2].split(',').map((v) => parseFloat(v));
  const y = values[1] ? parts[13] : parts[5];
  return Number.isFinite(y) ? y : 0;
}

/**
 * True once the deck is pinned at its sticky offset rather than sitting in its
 * own place in the page. Measured with the hide transform taken back out, so a
 * deck that has already slid away still reads as stuck.
 */
export function isPinned(deck: HTMLElement): boolean {
  const style = getComputedStyle(deck);
  if (style.position !== 'sticky') return false;
  const port = scrollportOf(deck);
  const scrolled = port
    ? port.scrollTop
    : window.scrollY || document.documentElement?.scrollTop || 0;
  // A scrollport at rest cannot have pushed anything to its sticky offset.
  if (scrolled <= 0) return false;
  const portTop = port ? port.getBoundingClientRect().top + port.clientTop : 0;
  const offset = parseFloat(style.top) || 0;
  const top = deck.getBoundingClientRect().top - translateYOf(style.transform);
  return top <= portTop + offset + 1;
}

export interface HideLobbyFilters {
  hidden: boolean;
  reveal: () => void;
}

export function useHideLobbyFiltersOnScroll(
  deckRef: RefObject<HTMLElement | null>,
  { resetKey, hold }: { resetKey: string; hold: boolean }
): HideLobbyFilters {
  const { hidden: travellingDown, reveal } = useHideFooterOnScroll(resetKey);
  const [pinned, setPinned] = useState(false);
  const [inUse, setInUse] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    let frame = 0;
    let pointerInside = false;

    const parts = (): HTMLElement[] => {
      const deck = deckRef.current;
      if (!deck) return [];
      const bar = sortbarOf(deck);
      return bar ? [deck, bar] : [deck];
    };
    const inside = (target: EventTarget | null) =>
      target instanceof Node && parts().some((part) => part.contains(target));

    const settle = () => {
      frame = 0;
      const deck = deckRef.current;
      /* Both have to be home. The sort row pins further down the page than
         the deck (the campaign and the ad bay sit between them in the flow),
         and lifting it before it has stuck would slide it up over those
         instead of behind the header. Above 900px the row is display: none
         and has no say. */
      const bar = deck ? sortbarOf(deck) : null;
      const barShown = Boolean(bar && bar.getClientRects().length > 0);
      setPinned(Boolean(deck && isPinned(deck) && (!barShown || (bar && isPinned(bar)))));
      setInUse(
        pointerInside || parts().some((part) => part.querySelector('[aria-expanded="true"]'))
      );
    };
    // Same coalescing as the footer: one read on the frame after the event.
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(settle);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!inside(event.target)) return;
      pointerInside = true;
      schedule();
    };
    // A touch that turns into a page scroll ends in pointercancel, so dragging
    // the page by the deck still lets it go.
    const onPointerEnd = () => {
      if (!pointerInside) return;
      pointerInside = false;
      schedule();
    };
    const onFocusIn = (event: FocusEvent) => {
      if (inside(event.target)) reveal();
    };

    document.addEventListener('scroll', schedule, { capture: true, passive: true });
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('pointerup', onPointerEnd, true);
    document.addEventListener('pointercancel', onPointerEnd, true);
    document.addEventListener('focusin', onFocusIn);
    window.addEventListener('resize', schedule, { passive: true });
    schedule();

    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      document.removeEventListener('scroll', schedule, { capture: true });
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('pointerup', onPointerEnd, true);
      document.removeEventListener('pointercancel', onPointerEnd, true);
      document.removeEventListener('focusin', onFocusIn);
      window.removeEventListener('resize', schedule);
    };
  }, [deckRef, reveal]);

  return { hidden: travellingDown && pinned && !inUse && !hold, reveal };
}
