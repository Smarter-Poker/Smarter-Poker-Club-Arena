/**
 * ONE ORDER, TWO CONTROLS (2026-10-24).
 *
 * The lobby has two ways to sort a tab: the "Sort The Board" chips in the
 * filter sheet (the page's Sort By, saved per tab in the view prefs) and the
 * column headings inside LobbyTable (saved per tab in localStorage). They
 * never talked to each other. On the cash tabs and on Spins / Heads Up the
 * board ALWAYS has a heading sort (the defaults are Stakes and Buy-In Low To
 * High), so a chip pressed in the sheet changed nothing on screen; on MTT and
 * ALL any heading the player had tapped once silently outranked the sheet for
 * ever after. A sort control that does nothing is a broken control.
 *
 * This module is the translation both ways, so pressing a chip sets the board
 * and tapping a heading lights the matching chip:
 *
 *   headingForOrder(tab, chip) -> the heading sort the board adopts, or
 *     'reset' (back to the tab's default board order) - never undefined.
 *   orderForHeading(tab, key, dir) -> the chip that heading means, or null
 *     when no chip says it (Status, Name, Seats...), which leaves the sheet.
 */

export type BoardOrderKey =
  | 'recommended'
  | 'stakes_high'
  | 'stakes_low'
  | 'players'
  | 'starting_soon';

export interface HeadingSort {
  key: string;
  dir: 'asc' | 'desc';
}

const CASH_TABS = new Set(['HOLDEM', 'OMAHA', 'LIMIT', 'MIXED']);
const SEAT_FIRST_TABS = new Set(['SPIN', 'SNG']);

/** The heading that carries a tab's price: Stakes on cash, Buy-In on events. */
function priceKey(tab: string): string | null {
  if (CASH_TABS.has(tab)) return 'stakes';
  if (tab === 'MTT' || SEAT_FIRST_TABS.has(tab)) return 'buyin';
  return null; // ALL: the page order is the board
}

export function headingForOrder(tab: string, order: string): HeadingSort | 'reset' {
  /* ALL has no default heading: its board IS the page order, so any chip
     clears a heading the player tapped earlier and lets that order show. */
  if (tab === 'ALL') return 'reset';
  const price = priceKey(tab);
  switch (order) {
    case 'stakes_high':
      return price ? { key: price, dir: 'desc' } : 'reset';
    case 'stakes_low':
      return price ? { key: price, dir: 'asc' } : 'reset';
    case 'players':
      return { key: 'players', dir: 'desc' };
    case 'starting_soon':
      /* MTT has a Starts heading; the page's own Starting Time order (still
         enterable first, then the clock) is what its default board shows. */
      return 'reset';
    case 'recommended':
    default:
      return 'reset';
  }
}

export function orderForHeading(
  tab: string,
  key: string,
  dir: 'asc' | 'desc'
): BoardOrderKey | null {
  const isPrice =
    (tab === 'ALL' && key === 'cost') || (priceKey(tab) !== null && key === priceKey(tab));
  if (isPrice) return dir === 'desc' ? 'stakes_high' : 'stakes_low';
  if (key === 'players' && dir === 'desc') return 'players';
  if (tab === 'MTT' && key === 'starts' && dir === 'asc') return 'starting_soon';
  return null;
}
