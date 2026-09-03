/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  useSwipeAction — Horizontal Swipe-to-Reveal Actions on List Items
 *  Exposes left/right swipe with configurable thresholds.
 *  Returns inline styles + event handlers to apply to a row element.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { useRef, useState, useMemo, useCallback } from 'react';

interface SwipeActionOptions {
  /** Width of the revealed action area (default 80px) */
  actionWidth?: number;
  /** Minimum horizontal drag to trigger reveal (default 40px) */
  threshold?: number;
  /** Called when left-swipe passes threshold */
  onSwipeLeft?: () => void;
  /** Called when right-swipe passes threshold */
  onSwipeRight?: () => void;
}

export function useSwipeAction(opts: SwipeActionOptions = {}) {
  const { actionWidth = 80, threshold = 40, onSwipeLeft, onSwipeRight } = opts;
  const startX = useRef(0);
  const startY = useRef(0);
  const [offset, setOffset] = useState(0);
  const [revealed, setRevealed] = useState<'left' | 'right' | null>(null);
  const isDragging = useRef(false);

  const handlers = useMemo(
    () => ({
      onPointerDown: (e: React.PointerEvent) => {
        startX.current = e.clientX;
        startY.current = e.clientY;
        isDragging.current = false;
      },
      onPointerMove: (e: React.PointerEvent) => {
        const dx = e.clientX - startX.current;
        const dy = e.clientY - startY.current;
        // Only start horizontal drag if horizontal movement dominates
        if (!isDragging.current && Math.abs(dy) > Math.abs(dx)) return;
        if (Math.abs(dx) > 10) isDragging.current = true;
        if (!isDragging.current) return;
        e.preventDefault();
        // Clamp to actionWidth range
        const clamped = Math.max(-actionWidth, Math.min(actionWidth, dx));
        setOffset(clamped);
      },
      onPointerUp: () => {
        if (Math.abs(offset) > threshold) {
          if (offset < 0) {
            // Swiped left → reveal left actions
            setRevealed('left');
            setOffset(-actionWidth);
            onSwipeLeft?.();
          } else {
            // Swiped right → reveal right actions
            setRevealed('right');
            setOffset(actionWidth);
            onSwipeRight?.();
          }
        } else {
          setOffset(0);
          setRevealed(null);
        }
        isDragging.current = false;
      },
      onPointerCancel: () => {
        setOffset(0);
        setRevealed(null);
        isDragging.current = false;
      },
    }),
    [offset, actionWidth, threshold, onSwipeLeft, onSwipeRight]
  );

  const reset = useCallback(() => {
    setOffset(0);
    setRevealed(null);
  }, []);

  const rowStyle: React.CSSProperties = {
    transform: `translateX(${offset}px)`,
    transition: isDragging.current
      ? 'none'
      : 'transform 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
    touchAction: 'pan-y',
  };

  return { handlers, rowStyle, offset, revealed, reset };
}
