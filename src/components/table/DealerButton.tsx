/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  DEALER BUTTON — Animated "D" chip on the table felt
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Renders the classic poker dealer button positioned near the dealer seat.
 * Smoothly animates between seat positions when the button moves.
 */

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  dealerButtonPosition,
  seatPodPx,
  buttonRadiusWidthPct,
  chipRestPosition,
  markerGapWidthPct,
  isOnFeltText,
  overlapsTopSeatBox,
  clampIntoFelt,
  feltCenter,
  BUTTON_FELT_MARGIN_WIDTH_PCT,
  FELT_MARKER_MARGIN_WIDTH_PCT,
  MARKER_MIN_GAP_WIDTH_PCT,
  FELT_WINDOW,
  NOMINAL_SCALER,
  type Pos,
  type Size,
} from './tableGeometry';
import { soundService } from '../../services/SoundService';
import { getAnimationSpeed } from '../../utils/animationSpeed';

/* ═══════════════════════════════════════════════════════════════════════════
   THE PUCK NEVER STANDS ON A NAME PLATE
   ═══════════════════════════════════════════════════════════════════════════

   Dan 2026-08-27: "the button should never overlap the action box. Move it
   forward more."

   WHAT WAS ACTUALLY WRONG. `tableGeometry.dealerButtonPosition` already refuses
   to put the puck on the printed masthead, on its own seat's chips, or off the
   felt, and since 2026-08-26 it refuses to put it inside a TOP-CAP seat's box
   (`overlapsTopSeatBox`, guarded by `seat.y < TOP_CAP_SEAT_Y_MAX`). Nothing
   ever checked the other seven chairs. The button walks 0.85 of the chip rail
   and is then projected onto the felt boundary - and every SIDE seat stands
   outside the felt, so the projection is what places it, and it places it hard
   against the rail directly beside the plate that is hanging over that rail.

   Measured over all eight production rings at the four table sizes the app
   renders (128 seat/size pairs): 36 of them put the puck's disc INSIDE the
   seat's own plate rectangle, worst 8.8px of overlap on a 375px phone. Every
   one is a side seat, x 8 or x 92. Nothing above 480px overlaps, which is why
   this reads as a phone bug. Three of them - the 6/7/8/9-max upper-left seat -
   additionally put the puck on the community board.

   WHY THE FIX IS HERE AND NOT IN tableGeometry.ts. It belongs in that module,
   beside `overlapsTopSeatBox`, as a one-line widening of that predicate to
   every seat. That file is outside this workstream's ownership for this round,
   so the correction is applied at the one call site instead - and it is applied
   as a REFINEMENT, never a second opinion: `dealerButtonPositionClearOfSeat`
   starts from the module's own answer, keeps it untouched whenever it is
   already clear, and when it is not, re-checks every condition the module
   checks before accepting a replacement. It can only ever move a puck that was
   demonstrably standing on something.

   FOLD THIS BACK. When tableGeometry.ts is free, move `overlapsSeatPlate` into
   it, add it to that function's `clear()` predicate, drop the `seat.y < 20`
   guard from `overlapsTopSeatBox`, and delete this wrapper. The seat-plate and
   board assertions in tests/unit/seatCardsAndPlate.test.tsx should then be
   pointed back at `dealerButtonPosition` unchanged.
   ═══════════════════════════════════════════════════════════════════════════ */

/** Square space: y scaled so one unit of x and one unit of y are the same distance. */
function sq(p: Pos, size: Size): Pos {
  return { x: p.x, y: (p.y * size.h) / size.w };
}

/**
 * True when the puck's disc intersects the seat's own rendered plate.
 *
 * The plate is `seatPodPx` - the avatar over the nameplate, the same rectangle
 * `chipStepWidthPct` already walks the CHIPS around, so the two markers are
 * judged against one model of the seat rather than two. `.seat-wrapper` is
 * `translate(-50%, -50%)`, so the box is centred on the seat's anchor on both
 * axes.
 *
 * The disc is tested against the box's square shell (clear on either axis by at
 * least the puck's radius), which is conservative at the corners - it keeps the
 * puck a radius away from a corner it could in principle stand a little nearer.
 * Conservative is the right direction for a "never overlap" instruction.
 */
export function overlapsSeatPlate(
  cand: Pos,
  seat: Pos,
  size: Size = NOMINAL_SCALER,
  pod?: Size
): boolean {
  if (!pod) return false;
  const halfW = (pod.w / 2 / size.w) * 100;
  const halfH = (pod.h / 2 / size.w) * 100;
  const r = buttonRadiusWidthPct(size);
  const c = sq(cand, size);
  const s = sq(seat, size);
  const clearOnX = Math.abs(c.x - s.x) - halfW >= r;
  const clearOnY = Math.abs(c.y - s.y) - halfH >= r;
  return !(clearOnX || clearOnY);
}

/**
 * True when the puck's disc intersects the community board.
 *
 * The same rectangle tests/table-seat-ring-integrity.test.ts measures the puck
 * against - the middle 95% of the felt's width, five cards at 64:92 with 2px
 * gaps, hung at 42.5% of the felt's height. Restated rather than imported
 * because that file deliberately owns its own copy; the numbers must be kept
 * in step, and the test in tests/unit/seatCardsAndPlate.test.tsx re-runs the
 * assertion against THIS function so a drift is caught rather than assumed
 * away.
 *
 * Checked here because pushing the puck off a plate pushes it toward the middle
 * of the table, which is where the cards are. A fix for one overlap that
 * creates another is not a fix.
 */
export function overlapsBoard(cand: Pos, size: Size = NOMINAL_SCALER): boolean {
  const BOARD_FELT_FRACTION = 0.95;
  const BOARD_GAP_PX = 2;
  const BOARD_TOP_FELT_PCT = 42.5;
  const centreX = FELT_WINDOW.left + FELT_WINDOW.width / 2;
  const centreY = FELT_WINDOW.top + (BOARD_TOP_FELT_PCT / 100) * FELT_WINDOW.height;
  const halfW = (BOARD_FELT_FRACTION * FELT_WINDOW.width) / 2;
  const gapPct = (BOARD_GAP_PX / size.w) * 100;
  const cardW = (BOARD_FELT_FRACTION * FELT_WINDOW.width - 4 * gapPct) / 5;
  const halfH = (cardW * (92 / 64) * (size.w / size.h)) / 2;
  const puckHalf = FELT_MARKER_MARGIN_WIDTH_PCT;
  return (
    Math.abs(cand.x - centreX) < halfW + puckHalf &&
    Math.abs(cand.y - centreY) < halfH + puckHalf * (size.w / size.h)
  );
}

/**
 * Where this seat's dealer button actually stands.
 *
 * `dealerButtonPosition` first, unchanged, so every guarantee that module makes
 * still holds. Then, and only if that answer stands on the seat's own plate or
 * on the community board, the same swing the module itself uses: around the
 * centre of the felt, 1.5 degrees at a time out to a quarter turn, each
 * candidate projected back onto the button's own felt boundary before it is
 * judged, both directions searched to their first acceptable angle, and the
 * winner the candidate nearest its OWN seat - so a puck can never drift toward
 * a neighbouring chair, which is the invariant tests/unit/chipRail.test.ts
 * exists to protect.
 *
 * A candidate must satisfy EVERYTHING at once, the module's conditions
 * included: clear of its own chips, off the printed masthead, out of a top-cap
 * seat's box, off its own plate, and off the board. Solving them one at a time
 * lets a later rotation walk the puck back into an earlier problem.
 *
 * Falls back to the module's answer if nothing clears, so this can never make a
 * seat worse than it is today. Measured: it never has to - the widest swing any
 * of the 36 overlapping seat/size pairs needs is 9 degrees.
 */
export function dealerButtonPositionClearOfSeat(
  seat: Pos,
  size: Size = NOMINAL_SCALER,
  pod?: Size
): Pos {
  const placed = dealerButtonPosition(seat, size, pod);

  const chips = chipRestPosition(seat, size, pod);
  const puck = buttonRadiusWidthPct(size);
  const clear = (p: Pos) =>
    markerGapWidthPct(p, chips, size) >= MARKER_MIN_GAP_WIDTH_PCT &&
    !isOnFeltText(p, size, puck) &&
    !overlapsTopSeatBox(p, seat, size) &&
    !overlapsSeatPlate(p, seat, size, pod) &&
    !overlapsBoard(p, size);

  if (clear(placed)) return placed;

  const c = feltCenter();
  const pv = sq(placed, size);
  const cv = sq(c, size);
  const sv = sq(seat, size);
  let best: Pos | null = null;
  let bestDist = Infinity;
  for (const dir of [1, -1]) {
    for (let i = 1; i <= 60; i++) {
      const phi = dir * i * 1.5 * (Math.PI / 180);
      const cosP = Math.cos(phi);
      const sinP = Math.sin(phi);
      const vx = pv.x - cv.x;
      const vy = pv.y - cv.y;
      const swung: Pos = {
        x: cv.x + vx * cosP - vy * sinP,
        y: ((cv.y + vx * sinP + vy * cosP) * size.w) / size.h,
      };
      const cand = clampIntoFelt(swung, size, BUTTON_FELT_MARGIN_WIDTH_PCT);
      if (clear(cand)) {
        const cs = sq(cand, size);
        const d = Math.hypot(cs.x - sv.x, cs.y - sv.y);
        if (d < bestDist) {
          best = cand;
          bestDist = d;
        }
        break; // this direction's first (smallest-swing) acceptable candidate
      }
    }
  }
  return best ?? placed;
}

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
    // 2026-08-27: scaled with --animation-speed like the CSS glide below, so
    // the tock still lands exactly when the puck does at every speed. The
    // 600ms glide + landing is the BUTTON_MOVE_MS beat in handCompletionSpec.
    const t = setTimeout(
      () => soundService.playDealerButtonMove(),
      Math.round(600 * getAnimationSpeed())
    );
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
  // The third argument is NOT the puck's own rail - the puck still stands at
  // BUTTON_RAIL_RATIO of the common rail. It is the seat's POD, and it reaches
  // the module for one reason: since 2026-08-26 the bet chips walk far enough
  // to clear that pod, so the module has to know where the chips really are
  // before it can judge whether the two markers are far enough apart. Handing
  // it nothing would have it dodge a stack that is no longer there.
  // Hero-ness from the ring POSITION, the same test TablePage tags the hero
  // wrapper with, never from the seat index.
  // `...ClearOfSeat` rather than `dealerButtonPosition` itself: the module's
  // answer, kept whenever it is already clear, and swung off the seat's own
  // name plate (and off the community board) when it is not. See the block at
  // the top of this file for the measurement, and for how to fold it back into
  // tableGeometry.ts where it belongs.
  const { x: btnX, y: btnY } = dealerButtonPositionClearOfSeat(
    pos,
    scalerSize ?? undefined,
    typeof window === 'undefined'
      ? undefined
      : seatPodPx(window.innerWidth, pos.y >= 100 && pos.x === 50)
  );

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
        // 2026-08-27: the glide honours the player's Animation Speed like
        // every other table animation (it was the last hardcoded mover).
        transition:
          'left calc(0.6s * var(--animation-speed, 1)) cubic-bezier(0.25, 0.46, 0.45, 0.94), top calc(0.6s * var(--animation-speed, 1)) cubic-bezier(0.25, 0.46, 0.45, 0.94)',
      }}
    >
      D
    </div>
  );
}

export default DealerButton;
