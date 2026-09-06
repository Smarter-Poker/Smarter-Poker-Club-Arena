/**
 * A dashboard read is authoritative only while it remains the newest request
 * and no later mutation receipt has been applied. This prevents a slow
 * pre-claim, pre-reroll, or pre-purchase read from restoring stale balances.
 */
export function isCurrentDailyMissionDashboardReceipt(
  receiptRequestId: number,
  latestRequestId: number,
  receiptMutationEpoch: number,
  currentMutationEpoch: number
): boolean {
  return receiptRequestId === latestRequestId && receiptMutationEpoch === currentMutationEpoch;
}
