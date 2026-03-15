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
 */

import { useRef, useEffect, useCallback } from 'react';

const FOCUSABLE_SELECTORS =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function useFocusTrap(isActive: boolean) {
  const containerRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key !== 'Tab' || !containerRef.current) return;

    const focusableElements =
      containerRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTORS);
    if (focusableElements.length === 0) return;

    const firstFocusable = focusableElements[0];
    const lastFocusable = focusableElements[focusableElements.length - 1];

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
    if (focusableElements.length > 0) {
      // Small delay to allow the modal animation to start
      rafId = requestAnimationFrame(() => {
        focusableElements[0]?.focus();
      });
    }

    document.addEventListener('keydown', handleKeyDown);

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      document.removeEventListener('keydown', handleKeyDown);
      // Restore focus to the previously focused element
      previousFocusRef.current?.focus();
    };
  }, [isActive, handleKeyDown]);

  return containerRef;
}

export default useFocusTrap;
