/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  TOOLTIP — Tooltip & Popover Components
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import './Tooltip.css';

type TooltipPosition = 'top' | 'bottom' | 'left' | 'right';

interface TooltipProps {
  content: React.ReactNode;
  children: React.ReactElement;
  position?: TooltipPosition;
  delay?: number;
  className?: string;
  disabled?: boolean;
}

/**
 * Calculate tooltip position based on trigger element
 */
function calculatePosition(
  triggerRect: DOMRect,
  tooltipRef: HTMLDivElement | null,
  position: TooltipPosition
): { top: number; left: number } {
  if (!tooltipRef) return { top: 0, left: 0 };

  const tooltipRect = tooltipRef.getBoundingClientRect();
  const gap = 8;

  switch (position) {
    case 'top':
      return {
        top: triggerRect.top - tooltipRect.height - gap,
        left: triggerRect.left + (triggerRect.width - tooltipRect.width) / 2,
      };
    case 'bottom':
      return {
        top: triggerRect.bottom + gap,
        left: triggerRect.left + (triggerRect.width - tooltipRect.width) / 2,
      };
    case 'left':
      return {
        top: triggerRect.top + (triggerRect.height - tooltipRect.height) / 2,
        left: triggerRect.left - tooltipRect.width - gap,
      };
    case 'right':
      return {
        top: triggerRect.top + (triggerRect.height - tooltipRect.height) / 2,
        left: triggerRect.right + gap,
      };
  }
}

/**
 * Main tooltip component
 */
export function Tooltip({
  content,
  children,
  position = 'top',
  delay = 200,
  className = '',
  disabled = false,
}: TooltipProps) {
  const [isVisible, setIsVisible] = useState(false);
  const [coords, setCoords] = useState({ top: 0, left: 0 });
  const triggerRef = useRef<HTMLElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const timeoutRef = useRef<number>(0);

  const showTooltip = useCallback(() => {
    if (disabled) return;
    timeoutRef.current = window.setTimeout(() => {
      setIsVisible(true);
    }, delay);
  }, [delay, disabled]);

  const hideTooltip = useCallback(() => {
    clearTimeout(timeoutRef.current);
    setIsVisible(false);
  }, []);

  /**
   * A TAP OPENS IT TOO (2026-08-29).
   *
   * The trigger listened for `mouseenter`, `mouseleave`, `focus` and `blur`.
   * Focus was the right instinct and did nothing: a bare `<span>` is not
   * focusable, so nothing ever focused it, and `focus` only fired when a child
   * happened to be a control. On a phone — where Club Arena is mostly used, and
   * where `mouseenter` does not exist — this component delivered its content to
   * nobody. Hover was removed estate-wide on 2026-08-29, which makes the
   * pointer-only route the only route there was.
   *
   * Toggle rather than show, so the same tap that opens it closes it, and the
   * span is now genuinely focusable so the `onFocus` above finally means
   * something.
   */
  const toggleTooltip = useCallback(() => {
    if (disabled) return;
    clearTimeout(timeoutRef.current);
    setIsVisible((v) => !v);
  }, [disabled]);

  /* Tap-anywhere and Escape both dismiss. Without these a tooltip opened by tap
     has no way to close on a device with no pointer to move away. */
  useEffect(() => {
    if (!isVisible) return;
    const onDocDown = (e: Event) => {
      const t = e.target as Node | null;
      if (t && triggerRef.current?.contains(t)) return;
      if (t && tooltipRef.current?.contains(t)) return;
      hideTooltip();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') hideTooltip();
    };
    document.addEventListener('pointerdown', onDocDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDocDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [isVisible, hideTooltip]);

  useEffect(() => {
    if (isVisible && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      // Wait for tooltip to render, then calculate position
      requestAnimationFrame(() => {
        setCoords(calculatePosition(rect, tooltipRef.current, position));
      });
    }
  }, [isVisible, position]);

  useEffect(() => {
    return () => clearTimeout(timeoutRef.current);
  }, []);

  const tooltipContent = (
    <AnimatePresence>
      {isVisible && (
        <motion.div
          ref={tooltipRef}
          className={`tooltip tooltip-${position} ${className}`}
          style={{ top: coords.top, left: coords.left }}
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.9 }}
          transition={{ duration: 0.15 }}
        >
          {content}
        </motion.div>
      )}
    </AnimatePresence>
  );

  return (
    <>
      <span
        ref={triggerRef as React.RefObject<HTMLSpanElement>}
        /* Focusable, so `onFocus` is reachable and a keyboard user can read the
           content at all -- the span carried focus handlers but no tabIndex, so
           they had never once fired on their own. */
        tabIndex={disabled ? -1 : 0}
        role="button"
        aria-expanded={isVisible}
        onMouseEnter={showTooltip}
        onMouseLeave={hideTooltip}
        onFocus={showTooltip}
        onBlur={hideTooltip}
        onClick={toggleTooltip}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggleTooltip();
          }
        }}
        style={{ display: 'inline-flex' }}
      >
        {children}
      </span>
      {createPortal(tooltipContent, document.body)}
    </>
  );
}

/**
 * Info tooltip with icon
 */
export function InfoTooltip({
  content,
  position = 'top',
}: {
  content: React.ReactNode;
  position?: TooltipPosition;
}) {
  return (
    <Tooltip content={content} position={position}>
      <span className="info-tooltip-trigger">ⓘ</span>
    </Tooltip>
  );
}

/**
 * Popover (click-triggered tooltip with more content)
 */
export function Popover({
  trigger,
  children,
  position = 'bottom',
  className = '',
}: {
  trigger: React.ReactElement;
  children: React.ReactNode;
  position?: TooltipPosition;
  className?: string;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [coords, setCoords] = useState({ top: 0, left: 0 });
  const triggerRef = useRef<HTMLElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const togglePopover = useCallback(() => {
    setIsOpen((prev) => !prev);
  }, []);

  const closePopover = useCallback(() => {
    setIsOpen(false);
  }, []);

  // Position calculation
  useEffect(() => {
    if (isOpen && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      requestAnimationFrame(() => {
        setCoords(calculatePosition(rect, popoverRef.current, position));
      });
    }
  }, [isOpen, position]);

  // Close on outside click
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node) &&
        triggerRef.current &&
        !triggerRef.current.contains(e.target as Node)
      ) {
        closePopover();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen, closePopover]);

  // Close on escape
  useEffect(() => {
    if (!isOpen) return;

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closePopover();
    };

    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen, closePopover]);

  const popoverContent = (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          ref={popoverRef}
          className={`popover popover-${position} ${className}`}
          style={{ top: coords.top, left: coords.left }}
          initial={{ opacity: 0, scale: 0.95, y: position === 'top' ? 10 : -10 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95 }}
          transition={{ duration: 0.2 }}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );

  return (
    <>
      <span
        ref={triggerRef as React.RefObject<HTMLSpanElement>}
        onClick={togglePopover}
        style={{ display: 'inline-flex' }}
      >
        {trigger}
      </span>
      {createPortal(popoverContent, document.body)}
    </>
  );
}

export default Tooltip;
