/**
 * WHAT LEAVING A CLUB COSTS, IN THE QUESTION THAT ASKS (launch audit 2026-10-05).
 *
 * `fn_member_leave_to_treasury` moves every chip the member holds in the club
 * to the club treasury and deletes the membership. The confirmation said only
 * "This Action Cannot Be Undone": no balance, no mention of chips. Two taps
 * gave a player's whole club balance away without one word about it.
 *
 * `chips` is the member's own `club_members.chip_balance`, read when the
 * dialog opens: a number when it was read, `null` when it could not be. An
 * unreadable balance is never shown as zero.
 */
export function leaveClubWarning(chips: number | null): string {
  if (chips === null || !Number.isFinite(chips)) {
    return 'Any Chips You Hold In This Club Go Back To The Club And Cannot Be Recovered.';
  }
  if (chips > 0) {
    const amount = chips.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    return `You Hold ${amount} Chips Here. They Go Back To The Club And Cannot Be Recovered.`;
  }
  return 'This Action Cannot Be Undone.';
}
