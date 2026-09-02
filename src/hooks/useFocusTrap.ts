import { useEffect, useRef } from 'react';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A MODAL THAT CLAIMS aria-modal MUST ACTUALLY HOLD FOCUS (2026-09-01)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The seat buy-in sheet is `role="dialog" aria-modal="true"` over the whole
 * table. `aria-modal` tells assistive tech to ignore everything outside it, so
 * a keyboard or screen-reader user whose focus was still on the felt behind it
 * was tabbing through elements their software had just been told do not exist.
 * It had Escape, and Escape alone is the half of the contract that is easy.
 *
 * This is the other half, and it is deliberately the whole of it - a partial
 * trap is its own bug:
 *
 *   1. FIRST FOCUS moves into the dialog when it opens, so the player starts
 *      where the software says they are;
 *   2. TAB WRAPS at both ends, forwards and backwards, so focus cannot leave
 *      an element that has been declared the only thing on screen;
 *   3. FOCUS IS RESTORED to whatever had it when the dialog opened. Without
 *      this, closing a sheet drops focus onto <body> and a keyboard user has
 *      to tab from the top of the page to get back to the seat they were
 *      looking at.
 *
 * Deliberately NOT here: closing on Escape. The caller owns that, because only
 * the caller knows when closing is allowed - the buy-in sheet refuses while a
 * debit is in flight, and a hook that closed it anyway would spend money and
 * then hide the result.
 */
export function useFocusTrap(active: boolean) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const restoreToRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (!container) return;

    restoreToRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const focusable = () =>
      Array.from(
        container.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      ).filter((el) => el.offsetParent !== null || el === document.activeElement);

    /* First focus: the first control, or the container itself so the reader
       announces the dialog rather than leaving focus outside it. */
    const first = focusable()[0];
    if (first) first.focus();
    else {
      container.setAttribute('tabindex', '-1');
      container.focus();
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const items = focusable();
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const firstItem = items[0];
      const lastItem = items[items.length - 1];
      const activeEl = document.activeElement as HTMLElement | null;
      if (e.shiftKey && (activeEl === firstItem || !container.contains(activeEl))) {
        e.preventDefault();
        lastItem.focus();
      } else if (!e.shiftKey && (activeEl === lastItem || !container.contains(activeEl))) {
        e.preventDefault();
        firstItem.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      const restore = restoreToRef.current;
      /* Only restore to something still in the document. A seat that was
         removed while the sheet was open must not pull focus to a detached
         node, which parks it on <body> with no announcement. */
      if (restore && document.contains(restore)) restore.focus();
    };
  }, [active]);

  return containerRef;
}

export default useFocusTrap;
