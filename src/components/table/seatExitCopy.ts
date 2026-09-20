/**
 * WHAT A SEAT SAYS ABOUT ITS OWN MONEY, KEYED BY WHAT THE MONEY IS.
 *
 * Diamond Arena is a 1:1 clone of a chip club played with Diamonds instead of
 * chips (Dan 2026-09-11). The table page reached that for the felt, the
 * cashier and the top-up, but every sentence a player reads on the way OUT of
 * a seat still said "Chips": the five eviction explanations, the generic
 * removal toast, the three "your seat and chips stay on the table" refusals,
 * the reconnect reassurance, the header top-up tooltip and the three lines of
 * the seat-first buy-in sheet. A Diamond player who sat out too long was told
 * their chips were back in their wallet. They have no chip wallet.
 *
 * One module, one word substituted, so the two assets cannot drift apart
 * sentence by sentence and a chip seat reads exactly what it read before:
 * `seatUnits` answers "Chips" for a chip seat AND for a seat whose asset has
 * not landed yet, which is what the page printed for both until today.
 *
 * Title Case, no em dashes (Dan 2026-08-20): these are rendered through the
 * Toast layer or straight into markup, and a string that is already correct
 * cannot be mangled by a future change to it. The one lower-case line is the
 * reconnect warning, which has always been lower case in source and is Title
 * Cased by the Toast layer; it is kept byte-identical for the chip seat.
 */
import type { ArenaIdentity } from '../../../server/src/domain/ArenaContext';

export type SeatAsset = ArenaIdentity['asset'] | null | undefined;

/** The denomination a seat's copy names. Unknown reads as chips, as it always did. */
export function seatUnits(asset: SeatAsset): 'Chips' | 'Diamonds' {
  return asset === 'diamonds' ? 'Diamonds' : 'Chips';
}

/**
 * Why a player was removed, in words they can act on.
 *
 * Both boot paths quote the same sentence (they used to each carry their own
 * copy and the poll's had no per-reason text at all, so a five-minute sit-out
 * eviction that arrived by poll said only the generic line). An unmapped
 * reason answers undefined so the caller can decide whether the generic line
 * is true for its kind of table.
 */
export function bootExplanation(reason: string | undefined, asset: SeatAsset): string | undefined {
  if (!reason) return undefined;
  const units = seatUnits(asset);
  const explanations: Record<string, string> = {
    away_blind_cap: `You Were Away, So We Cashed You Out After One Small Blind And One Big Blind. Your ${units} Are Back In Your Wallet.`,
    sit_out_timeout: `You Sat Out Too Long And Were Cashed Out. Your ${units} Are Back In Your Wallet.`,
    abandoned_seat: `You Were Disconnected For Five Minutes, So Your Seat Was Cashed Out. Your ${units} Are Back In Your Wallet.`,
    busted_no_rebuy: `You Ran Out Of ${units} And Did Not Rebuy, So Your Seat Was Released.`,
    nit_game_vpip: `This Table Has A Minimum VPIP And You Were Below It, So You Were Cashed Out. Your ${units} Are Back In Your Wallet.`,
  };
  return explanations[reason];
}

/** The eviction reasons `bootExplanation` has words for. */
export const BOOT_REASONS = [
  'away_blind_cap',
  'sit_out_timeout',
  'abandoned_seat',
  'busted_no_rebuy',
  'nit_game_vpip',
] as const;

export interface SeatCopy {
  /** The generic removal toast, for a cash seat closed with no mapped reason. */
  removedFromTable: string;
  /** Appended to the engine's reason when a leave is refused: the seat is live. */
  seatStaysTapToReturn: string;
  /** Same, when the way back is to cash out from the tab. */
  seatStaysTapToReturnAndCashOut: string;
  /** The leave threw before the engine answered. */
  couldNotCashOutYet: string;
  /** Fifteen seconds without the engine, while seated. Toast layer Title Cases it. */
  reconnectingSeated: string;
  /** The header's top-up button tooltip. */
  addFunds: string;
  /** The seat-first buy-in button while the purchase is in flight. */
  takingYourFunds: string;
  /** The seat-first buy-in button when the wallet is known to be short. */
  notEnoughFunds: string;
  /** The seat-first footer after thirty stalled seconds. */
  stillFillingSeatIsSafe: string;
}

/** Every exit sentence a seat can say, for the asset it is funded in. */
export function seatCopy(asset: SeatAsset): SeatCopy {
  const units = seatUnits(asset);
  const lower = units.toLowerCase();
  return {
    removedFromTable: `You Were Removed From The Table. Your ${units} Are Back In Your Wallet.`,
    seatStaysTapToReturn: `Your Seat And ${units} Stay On The Table, Tap Its Tab To Return.`,
    seatStaysTapToReturnAndCashOut: `Your Seat And ${units} Stay On The Table, Tap Its Tab To Return And Cash Out.`,
    couldNotCashOutYet: `Could Not Cash Out Yet. Your Seat And ${units} Stay On The Table, Tap Its Tab To Return.`,
    reconnectingSeated: `Still reconnecting. Your seat and ${lower} are safe on the server.`,
    addFunds: `Add ${units}`,
    takingYourFunds: `Taking Your ${units}`,
    notEnoughFunds: `Not Enough ${units}`,
    stillFillingSeatIsSafe: `Still Filling Your Game, Your Seat And ${units} Are Safe`,
  };
}
