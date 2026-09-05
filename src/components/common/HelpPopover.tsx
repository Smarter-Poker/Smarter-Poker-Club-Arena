import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

interface HelpPopoverProps {
  label: string;
  children: string;
}

interface PopoverPosition {
  left: number;
  top: number;
  placement: 'above' | 'below';
}

/**
 * Help That Works With A Mouse, Keyboard, Or Touch Screen.
 *
 * The Popover Is Portaled To The Document Body So A Scrollable Form Cannot
 * Clip It. Hover And Focus Preview It; Click Or Tap Pins It Open Until The
 * User Clicks Elsewhere, Presses Escape, Or Clicks The Help Button Again.
 */
export function HelpPopover({ label, children }: HelpPopoverProps) {
  const id = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  /* The popover body is portaled to <body>, so it is NOT a descendant of the
     button - and the outside-tap test below used to ask the button alone, so a
     pointerdown inside the popover counted as "outside" and closed it. That is
     the same defect that made the lobby's Stakes and Variant menus unclickable
     (LobbyTable.tsx, 2026-09-05).

     IT CANNOT FIRE TODAY: TableConfigPage.css sets `pointer-events: none` on
     `.config-help__popover`, so the body is never a pointer target, and the
     content is static text in any case. This is wiring ahead of the first
     interactive child, not a fix for a live symptom - if that rule is ever
     relaxed, containment is already correct rather than newly broken. */
  const popoverRef = useRef<HTMLSpanElement>(null);
  const pinnedRef = useRef(false);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<PopoverPosition | null>(null);

  const placePopover = useCallback(() => {
    const button = buttonRef.current;
    if (!button) return;

    const rect = button.getBoundingClientRect();
    const width = Math.min(300, window.innerWidth - 24);
    const left = Math.min(
      Math.max(12, rect.left + rect.width / 2 - width / 2),
      window.innerWidth - width - 12
    );
    const placement = rect.top > 120 ? 'above' : 'below';
    setPosition({
      left,
      top: placement === 'above' ? rect.top - 10 : rect.bottom + 10,
      placement,
    });
  }, []);

  const show = () => {
    placePopover();
    setOpen(true);
  };

  const close = () => {
    pinnedRef.current = false;
    setOpen(false);
  };

  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      const inside = buttonRef.current?.contains(target) || popoverRef.current?.contains(target);
      if (!inside) close();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        close();
      }
    };
    const handleViewportChange = () => placePopover();

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', handleViewportChange);
    window.addEventListener('scroll', handleViewportChange, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', handleViewportChange);
      window.removeEventListener('scroll', handleViewportChange, true);
    };
  }, [open, placePopover]);

  return (
    <span className="config-help">
      <button
        ref={buttonRef}
        type="button"
        className="config-help__button"
        aria-label={`Help: ${label}`}
        aria-expanded={open}
        aria-controls={id}
        onMouseEnter={show}
        onMouseLeave={() => {
          if (!pinnedRef.current) setOpen(false);
        }}
        onFocus={show}
        onBlur={() => {
          if (!pinnedRef.current) setOpen(false);
        }}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          pinnedRef.current = !pinnedRef.current;
          if (pinnedRef.current) show();
          else setOpen(false);
        }}
      >
        ?
      </button>
      {open &&
        position &&
        createPortal(
          <span
            id={id}
            ref={popoverRef}
            role="tooltip"
            className={`config-help__popover config-help__popover--${position.placement}`}
            style={{ left: position.left, top: position.top }}
          >
            {children}
          </span>,
          document.body
        )}
    </span>
  );
}
