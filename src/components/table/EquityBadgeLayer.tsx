/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE ALL-IN WIN PERCENTAGES - ONE LAYER, ON TOP OF THE FELT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-10-04 (binding): "THE '50%' TO WIN SHOULD NEVER BE 'IN THE
 * BACKGROUND' OR HAVE ANYTHING OVER IT, THEY SHOULD ALWAYS APPEAR AS LAYER 1
 * ... ALWAYS LAYER ONE ON TOP, BUT CAN NEVER COVER A PLAYERS DISPLAYED CARDS."
 *
 * WHY IT WAS IN THE BACKGROUND. Each badge used to be a child of its own
 * `.seat-wrapper`. Every wrapper is a stacking context (it is positioned with
 * a transform), so a badge's z-index only ever counted INSIDE its own seat.
 * The 2026-08-28 fix lifted a seat carrying a badge to z 28 - which works
 * against a seat with no badge, and does nothing when the neighbour is in the
 * same runout: two wrappers at 28, DOM order decides, and the later seat's
 * avatar and name plate paint straight over the earlier seat's percentage.
 * That is the green 50% sitting behind a player in Dan's screenshot. No
 * z-index on the badge can fix it from inside the wrapper.
 *
 * So the badges are not inside the seats any more. This layer is a sibling of
 * the seats, above all of them, and it places each badge from the seat's
 * measured box. Because a badge on top hides whatever is beneath it, the
 * placement refuses any spot that touches a displayed card
 * (lib/equityBadgePlacement.ts).
 *
 * The measuring is a layout read after render, not a timer. It runs when the
 * set of badges changes, when the page says a card came onto the felt
 * (`remeasureKey`), and - while badges are showing - whenever the felt itself
 * reports one of the three things that move a seat or a card under a badge:
 *
 *   - the felt changes size (ResizeObserver on the layer's parent; a window
 *     listener missed the tile/tab toggle and a band opening, which resize the
 *     felt without resizing the window);
 *   - a seat tables its hand (SeatSlot adds `.seat__cards--revealed` after a
 *     per-seat stagger, and the revealed row is larger: a badge placed against
 *     face-down fans would otherwise sit on a face-up card until the flop);
 *   - that reveal finishes its ~0.2s size transition, so the box avoided is
 *     the one the cards settle at, not the one they started from.
 *
 * UNITS. In multi-table tile view the whole table page is drawn under
 * `transform: scale(0.5)`. getBoundingClientRect() answers in SCALED px while
 * `left/top` and offsetWidth are the layer's own unscaled layout px, so every
 * measured box is divided by the layer's scale before it is used. Without
 * that a badge lands halfway between the layer's corner and its seat.
 */

import { useLayoutEffect, useRef, useState } from 'react';
import {
  placeEquityBadges,
  type Box,
  type EquityBadgePlacement,
  type EquitySpot,
} from '../../lib/equityBadgePlacement';

export interface EquityBadge {
  seatNumber: number;
  equity: number;
  /** Spots to try, best first (Dan 2026-08-28: above; top-cap seats to a side). */
  order: EquitySpot[];
}

/** Every card face a badge must not cover. */
const DISPLAYED_CARD_SELECTOR = [
  '.seat__cards--revealed .seat__card',
  '.seat__cards--hero .seat__card',
  '.community-cards__card',
].join(', ');
/** A seat's hole-card row; its class list changes when the hand is tabled. */
const CARD_ROW = 'seat__cards';

/** Painted px per layout px along one axis; 1 when either is unknown. */
function axisScale(painted: number, layout: number): number {
  const ratio = painted / layout;
  return Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
}

/** `el`'s box relative to the layer, in the layer's own (unscaled) layout px. */
function relativeBox(el: Element, origin: DOMRect, sx: number, sy: number): Box {
  const r = el.getBoundingClientRect();
  return {
    left: (r.left - origin.left) / sx,
    top: (r.top - origin.top) / sy,
    width: r.width / sx,
    height: r.height / sy,
  };
}

export function EquityBadgeLayer({
  badges,
  remeasureKey = '',
}: {
  badges: EquityBadge[];
  /**
   * Changes whenever a card comes onto (or leaves) the felt - the board
   * growing a street, a hand being tabled - so the badges are checked against
   * the cards that are on display NOW, not the ones that were there when the
   * runout began.
   */
  remeasureKey?: string;
}) {
  const layerRef = useRef<HTMLDivElement | null>(null);
  const [placements, setPlacements] = useState<Record<string, EquityBadgePlacement>>({});
  const [measureTick, setMeasureTick] = useState(0);
  /* Position depends on WHICH seats carry a badge and where they may go, not
     on the number printed in it - the street-by-street change of a percentage
     must not re-measure the felt. */
  const signature = badges.map((b) => `${b.seatNumber}:${b.order.join('')}`).join('|');

  const hasBadges = badges.length > 0;
  useLayoutEffect(() => {
    const scope = layerRef.current?.parentElement;
    if (!hasBadges || !scope) return;
    const remeasure = () => setMeasureTick((n) => n + 1);

    /* The felt changed size. Without ResizeObserver (old engines, some test
       DOMs) the window is the best signal there is. */
    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(remeasure);
      resizeObserver.observe(scope);
    } else {
      window.addEventListener('resize', remeasure);
    }

    /* A hand was tabled (or mucked): the class list of a `.seat__cards` row
       changed. Only that - the layer's own slots and every other class on the
       felt change constantly during a runout and move nothing. */
    let mutationObserver: MutationObserver | null = null;
    if (typeof MutationObserver !== 'undefined') {
      mutationObserver = new MutationObserver((records) => {
        if (
          records.some((r) => r.target instanceof Element && r.target.classList.contains(CARD_ROW))
        ) {
          remeasure();
        }
      });
      mutationObserver.observe(scope, {
        subtree: true,
        attributes: true,
        attributeFilter: ['class'],
      });
    }

    /* ...and the tabled cards finished growing to their face-up size. */
    const onTransitionEnd = (event: Event) => {
      const target = event.target;
      if (target instanceof Element && target.closest(`.${CARD_ROW}`)) remeasure();
    };
    scope.addEventListener('transitionend', onTransitionEnd);

    return () => {
      resizeObserver?.disconnect();
      if (!resizeObserver) window.removeEventListener('resize', remeasure);
      mutationObserver?.disconnect();
      scope.removeEventListener('transitionend', onTransitionEnd);
    };
  }, [hasBadges]);

  useLayoutEffect(() => {
    const layer = layerRef.current;
    if (!layer || badges.length === 0) return;
    const scope = layer.parentElement;
    if (!scope) return;
    const origin = layer.getBoundingClientRect();
    /* How much an ancestor transform has scaled the layer (0.5 in tile view,
       1 everywhere else). Everything below is in the layer's own layout px. */
    const sx = axisScale(origin.width, layer.offsetWidth);
    const sy = axisScale(origin.height, layer.offsetHeight);
    const cards = Array.from(scope.querySelectorAll(DISPLAYED_CARD_SELECTOR))
      .map((el) => relativeBox(el, origin, sx, sy))
      .filter((b) => b.width > 0 && b.height > 0);
    const requests = badges.flatMap((badge) => {
      const key = String(badge.seatNumber);
      const seatEl = scope.querySelector(`.seat-wrapper[data-seat-wrapper="${key}"]`);
      const badgeEl = layer.querySelector(`[data-equity-seat="${key}"]`);
      if (!seatEl || !badgeEl) return [];
      /* offsetWidth/Height, not the bounding rect: the badge is mid-"pop"
         (scaled 0.6 to 1.18) when this runs, and its LAYOUT size is the size
         it settles at. Already unscaled, like every box beside it. */
      const slot = badgeEl as HTMLElement;
      return [
        {
          key,
          seat: relativeBox(seatEl, origin, sx, sy),
          size: { width: slot.offsetWidth, height: slot.offsetHeight },
          order: badge.order,
        },
      ];
    });
    const next: Record<string, EquityBadgePlacement> = {};
    for (const p of placeEquityBadges(requests, cards, {
      width: layer.offsetWidth || origin.width / sx,
    }))
      next[p.key] = p;
    setPlacements((prev) => {
      const keys = Object.keys(next);
      const same =
        keys.length === Object.keys(prev).length &&
        keys.every(
          (k) =>
            prev[k] &&
            prev[k].spot === next[k].spot &&
            Math.abs(prev[k].left - next[k].left) < 0.5 &&
            Math.abs(prev[k].top - next[k].top) < 0.5
        );
      return same ? prev : next;
    });
    // `signature` stands in for `badges`: see the note where it is built.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, measureTick, remeasureKey]);

  if (badges.length === 0) return null;

  return (
    <div className="equity-layer" ref={layerRef}>
      {badges.map((badge) => {
        const key = String(badge.seatNumber);
        const at = placements[key];
        const isAhead = badge.equity >= 50;
        return (
          <div
            key={key}
            className="equity-layer__slot"
            data-equity-seat={key}
            data-equity-spot={at?.spot}
            /* Until it has been measured it is laid out (so it CAN be
               measured) but not painted: a badge must never flash in the
               corner of the felt on its way to its seat. */
            style={
              at
                ? { left: `${at.left}px`, top: `${at.top}px` }
                : { left: 0, top: 0, visibility: 'hidden' }
            }
          >
            {/* Keyed on the value so each street's new percentage replays the
                pop (ANIMATION AUDIT 2026-08-19); ahead/behind colours
                cross-fade in CSS. */}
            <div
              key={`eq-${badge.equity}`}
              className={`equity-overlay ${isAhead ? 'equity-overlay--ahead' : 'equity-overlay--behind'}`}
            >
              {badge.equity}%
              {/* Fixed-width track (AUDIT-2 2026-08-20) so every seat's bar is
                  drawn on the same scale. */}
              <span className="equity-overlay__track">
                <span
                  className="equity-overlay__bar"
                  style={{ width: `${Math.max(2, Math.min(100, badge.equity))}%` }}
                />
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default EquityBadgeLayer;
