/**
 * THE SEAT TAP KNOWS WHETHER YOU CAN AFFORD THE GAME (Dan 2026-10-14).
 *
 * "WHEN CHECKING IF A PLAYER HAS ENOUGH CHIPS BEFORE TAKING A SEAT ... IT
 * SHOULD JUST CHECK AUTOMATICALLY, AND IF THE USER DOESN'T HAVE ENOUGH CHIPS,
 * WHEN THEY HIT THE + BUTTON TO SIT DOWN, IT SHOULD POP UP THAT THEY DO NOT
 * HAVE ENOUGH CHIPS FOR THIS GAME."
 *
 * Pure, so the rule is pinned by a test rather than by a 28,000 line page.
 * A balance that could not be read (null) is UNKNOWN, never "short": refusing
 * a funded player on a failed read is the 2026-08-28 bug this file must not
 * bring back.
 */
export type SeatTapVerdict = 'ok' | 'short' | 'unknown';

export function seatTapBalanceVerdict(balance: number | null, needed: number): SeatTapVerdict {
  if (balance === null || !Number.isFinite(balance)) return 'unknown';
  if (!Number.isFinite(needed) || needed <= 0) return 'ok';
  return balance + 1e-9 >= needed ? 'ok' : 'short';
}

function amount(v: number): string {
  return Number.isInteger(v)
    ? v.toLocaleString('en-US')
    : v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Title Case, no em dashes (CLAUDE.md 5.7). */
export function notEnoughChipsText(needed: number, balance: number, unit = 'Chips'): string {
  return `You Do Not Have Enough ${unit} For This Game. The Minimum Buy In Is ${amount(needed)} ${unit} And Your Balance Is ${amount(Math.max(0, balance))} ${unit}.`;
}
