/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  BottomSheet — iOS-style Bottom Sheet Modal
 *  Slides up from bottom, drag-to-dismiss, backdrop fades in.
 *  Detent support for half-height and full-height modes.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { useEffect, useRef, useState, useCallback } from 'react';

interface BottomSheetProps {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
  /** Height detent: 'half' = 50vh, 'full' = 90vh, or a px number */
  detent?: 'half' | 'full' | number;
  children: React.ReactNode;
}

export default function BottomSheet({
  isOpen,
  onClose,
  title,
  detent = 'half',
  children,
}: BottomSheetProps) {
  const [translateY, setTranslateY] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const startY = useRef(0);
  const sheetRef = useRef<HTMLDivElement>(null);

  const maxHeight = detent === 'half' ? '50vh' : detent === 'full' ? '90vh' : `${detent}px`;

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    startY.current = e.clientY;
    setIsDragging(true);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, []);

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!isDragging) return;
      const dy = e.clientY - startY.current;
      if (dy > 0) {
        setTranslateY(dy);
      }
    },
    [isDragging]
  );

  const handlePointerUp = useCallback(() => {
    setIsDragging(false);
    if (translateY > 100) {
      onClose();
    }
    setTranslateY(0);
  }, [translateY, onClose]);

  // Reset on close
  useEffect(() => {
    if (!isOpen) setTranslateY(0);
  }, [isOpen]);

  // Lock body scroll
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
      return () => {
        document.body.style.overflow = '';
      };
    }
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(0, 0, 0, 0.6)',
          backdropFilter: 'blur(4px)',
          WebkitBackdropFilter: 'blur(4px)',
          zIndex: 1050,
          animation: 'fadeIn 0.2s ease',
        }}
      />

      {/* Sheet */}
      <div
        ref={sheetRef}
        style={{
          position: 'fixed',
          bottom: 0,
          left: 0,
          right: 0,
          maxHeight,
          background: 'linear-gradient(180deg, #1a1a2e, #0d0d1a)',
          border: '1px solid rgba(255, 255, 255, 0.1)',
          borderBottom: 'none',
          borderRadius: '20px 20px 0 0',
          zIndex: 1051,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          transform: `translateY(${translateY}px)`,
          transition: isDragging
            ? 'none'
            : 'transform 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
          animation: 'animationsSlideUp 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
          boxShadow: '0 -4px 30px rgba(0, 0, 0, 0.5)',
        }}
      >
        {/* Drag handle */}
        <div
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          style={{
            display: 'flex',
            justifyContent: 'center',
            padding: '12px 0 8px',
            cursor: 'grab',
            touchAction: 'none',
          }}
        >
          <div
            style={{
              width: 36,
              height: 4,
              borderRadius: 2,
              background: 'rgba(255, 255, 255, 0.2)',
            }}
          />
        </div>

        {/* Title */}
        {title && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '0 20px 12px',
              borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
            }}
          >
            <h3
              style={{
                margin: 0,
                fontSize: '1rem',
                fontWeight: 600,
                color: '#fff',
              }}
            >
              {title}
            </h3>
            <button
              onClick={onClose}
              style={{
                width: 28,
                height: 28,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: 'rgba(255, 255, 255, 0.08)',
                border: 'none',
                borderRadius: '50%',
                color: '#aaa',
                fontSize: 14,
                cursor: 'pointer',
              }}
            >
              ✕
            </button>
          </div>
        )}

        {/* Content */}
        <div
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '16px 20px',
            WebkitOverflowScrolling: 'touch',
          }}
        >
          {children}
        </div>
      </div>
    </>
  );
}
