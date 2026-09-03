/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  useSwipeTabs — Touch-First Tab Swipe Navigation Hook
 *  Provides pointer-based horizontal swipe detection for tab switching.
 *  Uses native pointer events (no dependencies) with configurable threshold.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

// AUDIT 2026-08-20: swipe haptics called navigator.vibrate directly, so neither
// vibration switch reached them.
import { fireVibration } from '../utils/vibrationGate';

import { useRef, useCallback, useMemo } from 'react';

interface SwipeConfig<T extends string> {
  tabs: T[];
  activeTab: T;
  onTabChange: (tab: T) => void;
  threshold?: number; // minimum px to register swipe (default: 50)
}

/**
 * Returns pointer event handlers that detect horizontal swipes
 * and advance/retreat through the provided tab list.
 *
 * Usage:
 *   const swipeHandlers = useSwipeTabs({ tabs, activeTab, onTabChange });
 *   <div {...swipeHandlers}> ... </div>
 */
export function useSwipeTabs<T extends string>({
  tabs,
  activeTab,
  onTabChange,
  threshold = 50,
}: SwipeConfig<T>) {
  const startX = useRef<number | null>(null);
  const startY = useRef<number | null>(null);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    startX.current = e.clientX;
    startY.current = e.clientY;
  }, []);

  const onPointerUp = useCallback(
    (e: React.PointerEvent) => {
      if (startX.current === null || startY.current === null) return;

      const dx = e.clientX - startX.current;
      const dy = e.clientY - startY.current;

      // Only register horizontal swipes (ratio > 1.5:1 horizontal vs vertical)
      if (Math.abs(dx) > threshold && Math.abs(dx) > Math.abs(dy) * 1.5) {
        const currentIndex = tabs.indexOf(activeTab);
        if (currentIndex === -1) return;

        if (dx < 0 && currentIndex < tabs.length - 1) {
          // Swipe left → next tab
          onTabChange(tabs[currentIndex + 1]);
          // Haptic feedback if available
          fireVibration(10);
        } else if (dx > 0 && currentIndex > 0) {
          // Swipe right → previous tab
          onTabChange(tabs[currentIndex - 1]);
          fireVibration(10);
        }
      }

      startX.current = null;
      startY.current = null;
    },
    [tabs, activeTab, onTabChange, threshold]
  );

  const onPointerCancel = useCallback(() => {
    startX.current = null;
    startY.current = null;
  }, []);

  return useMemo(
    () => ({
      onPointerDown,
      onPointerUp,
      onPointerCancel,
      style: { touchAction: 'pan-y' as const }, // allow vertical scroll, capture horizontal
    }),
    [onPointerDown, onPointerUp, onPointerCancel]
  );
}
