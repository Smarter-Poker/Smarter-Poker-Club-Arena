/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHERE AN ALL-IN WIN PERCENTAGE GOES
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-10-04 (binding): "THE '50%' TO WIN SHOULD NEVER BE 'IN THE
 * BACKGROUND' OR HAVE ANYTHING OVER IT, THEY SHOULD ALWAYS APPEAR AS LAYER 1,
 * NEVER LAYER 2, 3 ETC. THIS GOES FOR ALL PERCENTAGE DISPLAYS, ALWAYS LAYER
 * ONE ON TOP, BUT CAN NEVER COVER A PLAYERS DISPLAYED CARDS."
 *
 * Two rules, and they pull against each other: the badge is the top layer of
 * the felt (EquityBadgeLayer draws it above every seat), so wherever it lands
 * it hides what is under it - therefore it must not land on a card. This file
 * is the arithmetic that keeps the second rule: pure, no DOM, so it can be
 * tested on numbers.
 *
 * It keeps Dan's 2026-08-28 preference order - "PERCENTAGES SHOULD ALWAYS BE
 * ABOVE THE AVATAR WHEN POSSIBLE, NOT BELOW, AND NOT TO THE RIGHT", top-cap
 * seats to a side - and only leaves the preferred spot when a displayed card
 * (or a badge already placed) is in it.
 */

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export type EquitySpot = 'above' | 'left' | 'right' | 'below';

export interface EquityBadgeRequest {
  key: string;
  /** The seat's own box (its `.seat-wrapper`), in layer coordinates. */
  seat: Box;
  /** The badge's measured size. */
  size: { width: number; height: number };
  /** Spots to try, best first. */
  order: EquitySpot[];
}

export interface EquityBadgePlacement {
  key: string;
  spot: EquitySpot;
  left: number;
  top: number;
}

/** Air between a seat and its badge, per spot. `above` clears the action badge. */
export const EQUITY_GAP = { above: 22, side: 6, below: 6 } as const;
/** A badge never touches the edge of the felt layer. */
const EDGE = 2;

export function overlapArea(a: Box, b: Box): number {
  const w = Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left);
  const h = Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top);
  return w > 0 && h > 0 ? w * h : 0;
}

function boxAt(req: EquityBadgeRequest, spot: EquitySpot, layer: { width: number }): Box {
  const { seat, size } = req;
  const cx = seat.left + seat.width / 2;
  const cy = seat.top + seat.height / 2;
  let left: number;
  let top: number;
  switch (spot) {
    case 'above':
      left = cx - size.width / 2;
      top = seat.top - EQUITY_GAP.above - size.height;
      break;
    case 'below':
      left = cx - size.width / 2;
      top = seat.top + seat.height + EQUITY_GAP.below;
      break;
    case 'right':
      left = seat.left + seat.width + EQUITY_GAP.side;
      top = cy - size.height / 2;
      break;
    default:
      left = seat.left - EQUITY_GAP.side - size.width;
      top = cy - size.height / 2;
  }
  // Keep it on the felt sideways; the layer is as wide as the table.
  const maxLeft = layer.width - EDGE - size.width;
  left = Math.max(EDGE, Math.min(left, Math.max(EDGE, maxLeft)));
  return { left, top, width: size.width, height: size.height };
}

/**
 * Place every badge. `cards` are the boxes of every card face on display -
 * tabled hole cards, the hero's own hand, the board. A spot that touches one
 * is refused; a badge already placed is avoided the same way. If every spot
 * a seat has touches something, the one touching the least CARD is taken
 * (cards outrank other badges), so a badge is never dropped: a percentage
 * that is not shown is the other half of the same rule being broken.
 */
export function placeEquityBadges(
  requests: EquityBadgeRequest[],
  cards: Box[],
  layer: { width: number }
): EquityBadgePlacement[] {
  const placed: Box[] = [];
  const out: EquityBadgePlacement[] = [];
  for (const req of requests) {
    const order = req.order.length > 0 ? req.order : (['above'] as EquitySpot[]);
    let best: { spot: EquitySpot; box: Box; cardHit: number; badgeHit: number } | null = null;
    for (const spot of order) {
      const box = boxAt(req, spot, layer);
      const cardHit = cards.reduce((sum, c) => sum + overlapArea(box, c), 0);
      const badgeHit = placed.reduce((sum, b) => sum + overlapArea(box, b), 0);
      if (cardHit === 0 && badgeHit === 0) {
        best = { spot, box, cardHit, badgeHit };
        break;
      }
      if (
        !best ||
        cardHit < best.cardHit ||
        (cardHit === best.cardHit && badgeHit < best.badgeHit)
      ) {
        best = { spot, box, cardHit, badgeHit };
      }
    }
    const chosen = best!;
    placed.push(chosen.box);
    out.push({ key: req.key, spot: chosen.spot, left: chosen.box.left, top: chosen.box.top });
  }
  return out;
}
