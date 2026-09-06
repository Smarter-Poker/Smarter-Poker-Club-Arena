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

/**
 * Realtime can announce a revision created by the dashboard transaction itself
 * before that dashboard response reaches the browser. Once every in-flight read
 * settles, only an unversioned event or a strictly newer revision needs another
 * read; an equal revision is the echo already represented by the accepted
 * receipt.
 */
export function shouldRefreshQueuedDailyMissionRealtime(
  queuedRevision: number | null,
  queuedUnversionedEvent: boolean,
  renderedRevision: number
): boolean {
  return (
    queuedUnversionedEvent ||
    (queuedRevision !== null &&
      Number.isInteger(queuedRevision) &&
      queuedRevision > renderedRevision)
  );
}

/** Extract only the positive safe-integer cursor shape emitted by Realtime. */
export function dailyMissionRevisionFromPayload(payload: unknown): number | null {
  const records: unknown[] = [payload];
  if (payload && typeof payload === 'object') {
    const envelope = payload as Record<string, unknown>;
    records.push(envelope.payload, envelope.data);
    if (envelope.payload && typeof envelope.payload === 'object') {
      records.push((envelope.payload as Record<string, unknown>).data);
    }
  }

  for (const candidate of records) {
    if (!candidate || typeof candidate !== 'object') continue;
    const revision = (candidate as Record<string, unknown>).revision;
    if (typeof revision === 'number' && Number.isSafeInteger(revision) && revision > 0) {
      return revision;
    }
  }
  return null;
}
