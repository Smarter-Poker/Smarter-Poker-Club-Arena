import React, { useState, useRef, useEffect } from 'react';
import './Tooltip.css';

interface TooltipProps {
  children: React.ReactNode;
  content: string;
  position?: 'top' | 'bottom' | 'left' | 'right';
  delay?: number;
}

export const Tooltip: React.FC<TooltipProps> = ({
  children,
  content,
  position = 'top',
  delay = 200,
}) => {
  const [visible, setVisible] = useState(false);
  // CA-17 BUG FIX: was useState(timeoutId) — caused an extra re-render on every
  // hover AND had no unmount cleanup. Using useRef avoids the re-render and lets
  // us cancel the pending show-delay timer when the component unmounts.
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  const showTooltip = () => {
    timeoutRef.current = setTimeout(() => {
      timeoutRef.current = null;
      setVisible(true);
    }, delay);
  };

  const hideTooltip = () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    setVisible(false);
  };

  /**
   * A TAP AND A KEYBOARD REACH IT TOO (2026-08-29).
   *
   * This was `onMouseEnter` / `onMouseLeave` and nothing else, on a plain
   * `<div>`. A phone has no `mouseenter`, so on the device most of Club Arena
   * is used from, this component delivered its content to nobody at all — and
   * neither did it for anyone navigating by keyboard. Hover was removed
   * estate-wide the same day, which leaves the pointer-only route as the only
   * route this ever had.
   */
  const toggle = () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    setVisible((v) => !v);
  };

  /* A tooltip opened by tap needs a way to close on a device with no pointer
     to move away from it. */
  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setVisible(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [visible]);

  return (
    <div
      className="tooltip-wrapper"
      tabIndex={0}
      role="button"
      aria-expanded={visible}
      onMouseEnter={showTooltip}
      onMouseLeave={hideTooltip}
      onFocus={showTooltip}
      onBlur={hideTooltip}
      onClick={toggle}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          toggle();
        }
      }}
    >
      {children}
      {visible && <div className={`tooltip position-${position}`}>{content}</div>}
    </div>
  );
};

export default Tooltip;
