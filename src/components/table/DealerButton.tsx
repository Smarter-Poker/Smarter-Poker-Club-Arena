/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  DEALER BUTTON — Animated "D" chip on the table felt
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Renders the classic poker dealer button positioned near the dealer seat.
 * Smoothly animates between seat positions when the button moves.
 */

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { dealerButtonPosition, type Size } from './tableGeometry';
import { soundService } from '../../services/SoundService';

export interface DealerButtonProps {
  /** Index of the dealer seat (visual index, 0-based) */
  dealerVisualIndex: number;
  /** Array of seat positions with x/y percentages */
  seatPositions: Array<{ x: number; y: number }>;
  /** Whether the button should be visible */
  isVisible: boolean;
  /**
   * REVIEW FIX 2026-08-19: multi-table gate (#175) — background tables must
   * not tock every hand. TablePage passes its ambientSoundsAllowed.
   */
  playSounds?: boolean;
}

/**
 * Dealer Button — White "D" chip positioned near the current dealer seat.
 * Uses CSS transitions for smooth movement between positions.
 */
export function DealerButton({
  dealerVisualIndex,
  seatPositions,
  isVisible,
  playSounds = true,
}: DealerButtonProps) {
  // COMPETITOR-PARITY 2026-08-19: one very soft felt 'tock' as the puck lands
  // on its new seat. Skipped on first mount — only actual moves speak. The
  // 600ms delay matches the CSS slide so the sound lands WITH the puck.
  /**
   * THE TABLE'S REAL SHAPE (audit 2026-08-25).
   *
   * `dealerButtonPosition` needs the scaler's aspect, and this component used
   * to let it default to NOMINAL_SCALER (605/1000) on the grounds that
   * TablePage.css locks that ratio at every breakpoint. That is true in
   * PORTRAIT. It is not true in landscape: the landscape block overrides
   * `.table-scaler` with `max-height: 100%` and `width: 100%`, and a definite
   * width plus a binding max-height beats `aspect-ratio` - the box is squashed
   * and its real ratio is whatever the viewport left it.
   *
   * That matters more than a few pixels of puck, because the CHIPS are already
   * computed against the measured box: TablePage feeds `betChipOffsetPx` its
   * ResizeObserver'd `scalerSize`. So in landscape the two markers were being
   * built from two different table shapes - which is the exact failure
   * tableGeometry.ts was written to make impossible ("when they were computed
   * in two places they disagreed").
   *
   * Measured from the puck's own offsetParent, which IS `.table-scaler`
   * (position: relative, and this element is absolutely positioned inside it),
   * so no new prop and no change in a file three other workstreams are editing.
   * `useLayoutEffect` so the first measurement lands in the same paint as the
   * markup - with a passive effect the puck would render at the nominal
   * position and then visibly GLIDE to the measured one, because the class
   * carries a 0.6s transition on left/top.
   */
  const elRef = useRef<HTMLDivElement | null>(null);
  const [scalerSize, setScalerSize] = useState<Size | null>(null);
  useLayoutEffect(() => {
    const host = elRef.current?.offsetParent as HTMLElement | null;
    if (!host) return;
    const read = () => {
      const w = host.offsetWidth;
      const h = host.offsetHeight;
      if (w <= 0 || h <= 0) return;
      setScalerSize((prev) => (prev && prev.w === w && prev.h === h ? prev : { w, h }));
    };
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(read);
    ro.observe(host);
    return () => ro.disconnect();
    // Re-armed when the puck appears, since there is no element to measure from
    // while it is hidden.
  }, [isVisible]);

  const prevIndexRef = useRef<number | null>(null);
  useEffect(() => {
    if (!isVisible || dealerVisualIndex < 0) return;
    const prev = prevIndexRef.current;
    prevIndexRef.current = dealerVisualIndex;
    if (prev == null || prev === dealerVisualIndex) return;
    if (!playSounds) return;
    const t = setTimeout(() => soundService.playDealerButtonMove(), 600);
    return () => clearTimeout(t);
  }, [dealerVisualIndex, isVisible, playSounds]);

  if (!isVisible || dealerVisualIndex < 0 || dealerVisualIndex >= seatPositions.length) {
    return null;
  }

  const pos = seatPositions[dealerVisualIndex];

  // Where the puck stands, in scaler percentages. tableGeometry owns this: it
  // builds the button off the SAME chip rail the bet chips rest on, so the two
  // markers cannot drift apart, and it guarantees two things this component
  // must not try to reproduce - the puck is always on the felt and never on the
  // painted rail (Dan 2026-08-25 item 11), and it is never on top of the chips
  // it belongs beside (item 13). Handed the MEASURED table shape when there is
  // one (see the layout effect above); the module's own 605/1000 default only
  // covers the very first paint, before the element exists to measure from.
  const { x: btnX, y: btnY } = dealerButtonPosition(pos, scalerSize ?? undefined);

  // Only position is inlined — every other visual property lives on the
  // `.dealer-button` CSS class so theme tokens, drop-in animation, and the
  // premium multi-layer shadows stay authoritative in one place. Its SIZE is
  // now a proportion of the table rather than a per-breakpoint pixel count:
  // --dealer-btn-size in TableVisualHotfix.css, section 4.
  return (
    <div
      ref={elRef}
      className="dealer-button"
      style={{
        left: `${btnX}%`,
        top: `${btnY}%`,
        transform: 'translate(-50%, -50%)',
        transition:
          'left 0.6s cubic-bezier(0.25, 0.46, 0.45, 0.94), top 0.6s cubic-bezier(0.25, 0.46, 0.45, 0.94)',
      }}
    >
      D
    </div>
  );
}

export default DealerButton;
