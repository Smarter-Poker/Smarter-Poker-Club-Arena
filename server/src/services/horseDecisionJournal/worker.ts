import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { HorseDecisionJournalStore, horseJournalCapacityReason } from './store.js';
import { validateHorseJournalRecord } from './record.js';
import { horseJournalFailureKind } from './failure.js';

if (isMainThread || !parentPort) throw Error('Horse journal requires its private worker');
const port = parentPort;
try {
  const store = new HorseDecisionJournalStore(workerData.directory, {
    archive: workerData.archive,
  });
  port.on('message', (message: unknown) => {
    if (message && typeof message === 'object' && 'type' in message && message.type === 'STOP') {
      store.close();
      port.postMessage({ type: 'STOPPED' });
      port.close();
      return;
    }
    if (message && typeof message === 'object' && 'type' in message && message.type === 'STATS') {
      // Aggregate-only diagnostics for /health. A failed read answers null and
      // never reclassifies the writer: a probe must not stop capture.
      let stats: ReturnType<typeof store.storageStats> | null = null;
      try {
        stats = store.storageStats();
      } catch {
        stats = null;
      }
      port.postMessage({ type: 'STATS', stats });
      return;
    }
    if (message && typeof message === 'object' && 'type' in message && message.type === 'PROBE') {
      // A paused publisher asks whether a quota has room for its next batch.
      // Read-only: nothing is reserved, written or deleted. A probe that cannot
      // be answered says no room, and never reclassifies or stops the writer.
      let reason: ReturnType<typeof store.capacityRefusal> | undefined;
      try {
        reason = store.capacityRefusal((message as { records?: unknown }).records as never);
      } catch {
        reason = undefined;
      }
      port.postMessage(
        reason === null
          ? { type: 'CAPACITY', room: true }
          : reason === undefined
            ? { type: 'CAPACITY', room: false }
            : { type: 'CAPACITY', room: false, reason }
      );
      return;
    }
    try {
      const batch = message as { type?: string; records?: unknown[] };
      if (batch?.type !== 'APPEND' || !Array.isArray(batch.records) || batch.records.length > 16)
        throw Error('Invalid batch');
      for (const record of batch.records) validateHorseJournalRecord(record);
      const records = batch.records as import('./record.js').HorseJournalRecord[];
      const statuses = store.appendBatch(records);
      port.postMessage({
        type: 'ACK',
        receipts: records.map((record, i) => ({
          eventId: record.eventId,
          sha256: record.sha256,
          status: statuses[i],
        })),
      });
    } catch (error) {
      // No paths, cards, identities or SQL errors in runtime/public messages.
      port.postMessage({
        type: horseJournalFailureKind(error),
        reason: horseJournalCapacityReason(error),
      });
    }
  });
  port.postMessage({ type: 'READY' });
} catch (error) {
  port.postMessage({
    type: horseJournalFailureKind(error),
    reason: horseJournalCapacityReason(error),
  });
  port.close();
}
