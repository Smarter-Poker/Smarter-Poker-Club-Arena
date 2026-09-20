/**
 * Player-facing sentences for each reason `fn_diamond_arena_reconciliation`
 * can name. Kept beside the statement, out of the component file so the
 * component exports only a component (fast refresh).
 */
export const UNMATCHED_COPY: Record<string, string> = {
  journal_missing: 'A Movement Has No Wallet Entry',
  reserve_amount_mismatch: 'A Buy-In Does Not Match Its Wallet Entry',
  release_amount_mismatch: 'A Cash-Out Does Not Match Its Wallet Entry',
  release_movement_missing: 'A Finished Session Has No Cash-Out On Record',
  seat_stack_drift: 'A Seat Stack Differs From The Diamonds Held For It',
};

export function unmatchedSentence(reason: string): string {
  return UNMATCHED_COPY[reason] || 'A Line Does Not Reconcile';
}
