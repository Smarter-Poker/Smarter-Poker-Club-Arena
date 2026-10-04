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
 * The measuring is a layout read after render, not a timer: it runs when the
 * set of badges changes and when the viewport does, which are the only two
 * things that move a seat during a runout.
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

function relativeBox(el: Element, origin: DOMRect): Box {
  const r = el.getBoundingClientRect();
  return { left: r.left - origin.left, top: r.top - origin.top, width: r.width, height: r.height };
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
  const [viewportTick, setViewportTick] = useState(0);
  /* Position depends on WHICH seats carry a badge and where they may go, not
     on the number printed in it - the street-by-street change of a percentage
     must not re-measure the felt. */
  const signature = badges.map((b) => `${b.seatNumber}:${b.order.join('')}`).join('|');

  useLayoutEffect(() => {
    if (badges.length === 0) return;
    const onResize = () => setViewportTick((n) => n + 1);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [badges.length]);

  useLayoutEffect(() => {
    const layer = layerRef.current;
    if (!layer || badges.length === 0) return;
    const scope = layer.parentElement;
    if (!scope) return;
    const origin = layer.getBoundingClientRect();
    const cards = Array.from(scope.querySelectorAll(DISPLAYED_CARD_SELECTOR))
      .map((el) => relativeBox(el, origin))
      .filter((b) => b.width > 0 && b.height > 0);
    const requests = badges.flatMap((badge) => {
      const key = String(badge.seatNumber);
      const seatEl = scope.querySelector(`.seat-wrapper[data-seat-wrapper="${key}"]`);
      const badgeEl = layer.querySelector(`[data-equity-seat="${key}"]`);
      if (!seatEl || !badgeEl) return [];
      /* offsetWidth/Height, not the bounding rect: the badge is mid-"pop"
         (scaled 0.6 to 1.18) when this runs, and its LAYOUT size is the size
         it settles at. */
      const slot = badgeEl as HTMLElement;
      return [
        {
          key,
          seat: relativeBox(seatEl, origin),
          size: { width: slot.offsetWidth, height: slot.offsetHeight },
          order: badge.order,
        },
      ];
    });
    const next: Record<string, EquityBadgePlacement> = {};
    for (const p of placeEquityBadges(requests, cards, { width: origin.width })) next[p.key] = p;
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
  }, [signature, viewportTick, remeasureKey]);

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
