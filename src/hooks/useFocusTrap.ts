/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  useFocusTrap — Trap keyboard focus inside a container
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * When active, Tab/Shift+Tab cycling is trapped inside the container ref.
 * Focus is moved to the first focusable element on mount, and restored
 * to the previously focused element on unmount.
 *
 * Usage:
 *   const trapRef = useFocusTrap(isOpen);
 *   return <div ref={trapRef}>...modal content...</div>
 *
 * Pass initialFocusRef when the element that should receive focus is NOT first
 * in DOM order. The default lands on the first focusable descendant, which
 * silently defeats autoFocus: React applies autoFocus during commit, this
 * effect runs afterwards, and the rAF below then moves focus elsewhere. Any
 * dialog whose header holds a button before its input needs this.
 */

import { useRef, useEffect, useCallback, type RefObject } from 'react';

const FOCUSABLE_SELECTORS =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function useFocusTrap<T extends HTMLElement = HTMLDivElement>(
  isActive: boolean,
  initialFocusRef?: RefObject<HTMLElement | null>
) {
  const containerRef = useRef<T>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key !== 'Tab' || !containerRef.current) return;

    const focusableElements =
      containerRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTORS);
    if (focusableElements.length === 0) return;

    const firstFocusable = focusableElements[0];
    const lastFocusable = focusableElements[focusableElements.length - 1];

    /* FOCUS OUTSIDE THE TRAP IS THE COMMON CASE, NOT AN EDGE ONE.
       This only ever intervened when focus was sitting on the first or the
       last focusable element. Tap any non-focusable part of a modal - a
       heading, a hint paragraph, a section's padding - and activeElement
       becomes <body>; the next Tab then matched neither branch, so the browser
       walked on to the first tabbable element in document order, which is the
       page BEHIND the portal. aria-modal does not stop keyboard focus, so the
       trap simply leaked. */
    if (!containerRef.current.contains(document.activeElement)) {
      e.preventDefault();
      (e.shiftKey ? lastFocusable : firstFocusable).focus();
      return;
    }

    if (e.shiftKey) {
      // Shift+Tab: wrap from first → last
      if (document.activeElement === firstFocusable) {
        e.preventDefault();
        lastFocusable.focus();
      }
    } else {
      // Tab: wrap from last → first
      if (document.activeElement === lastFocusable) {
        e.preventDefault();
        firstFocusable.focus();
      }
    }
  }, []);

  useEffect(() => {
    if (!isActive || !containerRef.current) return;

    // Remember what was focused before the trap
    previousFocusRef.current = document.activeElement as HTMLElement;

    // Focus the first focusable element inside the container
    const focusableElements =
      containerRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTORS);
    let rafId: number | null = null;
    if (initialFocusRef?.current || focusableElements.length > 0) {
      // Small delay to allow the modal animation to start
      rafId = requestAnimationFrame(() => {
        (initialFocusRef?.current ?? focusableElements[0])?.focus();
      });
    }

    document.addEventListener('keydown', handleKeyDown);

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      document.removeEventListener('keydown', handleKeyDown);
      // Restore focus to the previously focused element
      previousFocusRef.current?.focus();
    };
    // initialFocusRef is a ref object, so its identity is stable; listed to keep
    // the exhaustive-deps rule satisfied rather than because it can change.
  }, [isActive, handleKeyDown, initialFocusRef]);

  return containerRef;
}

export default useFocusTrap;
