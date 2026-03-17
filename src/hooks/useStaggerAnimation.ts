/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  useStaggerAnimation — Shared stagger entrance animation hook
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Consolidates the repeated stagger-entrance pattern found in:
 *   PlayerNotes.tsx, PlayerNotesPanel.tsx, AgentCommissionDashboard.tsx,
 *   RakeReports.tsx, TransactionHistory.tsx, and others.
 *
 * Usage:
 *   const { isVisible, style } = useStaggerAnimation(items.length);
 *   // Then in JSX:  style={style(index)}
 */

import { useState, useEffect, useRef } from 'react';

interface StaggerAnimationOptions {
  /** Delay between each item in ms (default: 50) */
  staggerMs?: number;
  /** CSS transition string (default: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)') */
  transition?: string;
  /** translateY offset when hidden (default: '8px') */
  offsetY?: string;
}

const DEFAULT_TRANSITION = 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)';

export function useStaggerAnimation(itemCount: number, options: StaggerAnimationOptions = {}) {
  const { staggerMs = 50, transition = DEFAULT_TRANSITION, offsetY = '8px' } = options;
  const [visible, setVisible] = useState<Set<number>>(new Set());
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    // Clear previous timers
    timers.current.forEach(clearTimeout);
    timers.current = [];
    setVisible(new Set());

    // Stagger-reveal each item
    for (let i = 0; i < itemCount; i++) {
      const t = setTimeout(() => setVisible((prev) => new Set(prev).add(i)), i * staggerMs);
      timers.current.push(t);
    }

    return () => {
      timers.current.forEach(clearTimeout);
      timers.current = [];
    };
  }, [itemCount, staggerMs]);

  /** Check if a given index is visible */
  const isVisible = (index: number): boolean => visible.has(index);

  /** Get inline style for the item at `index` */
  const style = (index: number): React.CSSProperties => ({
    opacity: visible.has(index) ? 1 : 0,
    transform: visible.has(index) ? 'translateY(0)' : `translateY(${offsetY})`,
    transition,
  });

  return { isVisible, style };
}
