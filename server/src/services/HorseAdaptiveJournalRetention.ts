import { supabase } from './supabase.js';
import { ADAPTIVE_JOURNAL_LIMITS } from './HorseAdaptiveObservationJournal.js';

/** One bounded background pass. Counts describe this transaction only; they
 * are never a completeness watermark or proof that every expired row is gone. */
export async function pruneAdaptiveJournal() {
  const unknown = () => Object.freeze({ status: 'unknown' as const });
  try {
    const { data, error } = await supabase
      .rpc('fn_prune_horse_adaptive_journal')
      .abortSignal(AbortSignal.timeout(ADAPTIVE_JOURNAL_LIMITS.timeoutMs));
    if (error || ![1, 2, 3].includes(data?.version)) return unknown();
    const versioned = data.version >= 2;
    const handLimit = data.version === 3 ? 250 : 25;
    if (data.status === 'unavailable' && data.reason === 'capacity_busy')
      return Object.freeze({ status: 'unavailable' as const, reason: 'capacity_busy' });
    if (
      data.status !== 'pruned' ||
      ![data.completedWork, data.batches, data.observations].every(
        (n) => Number.isSafeInteger(n) && n >= 0
      ) ||
      data.completedWork > 100 ||
      data.batches > 100 ||
      data.observations > (versioned ? handLimit * 4096 : 1000) ||
      (versioned &&
        (!Number.isSafeInteger(data.retiredHands) ||
          data.retiredHands < 0 ||
          data.retiredHands > handLimit ||
          !Number.isSafeInteger(data.statisticsExpired) ||
          data.statisticsExpired < 0 ||
          data.statisticsExpired > 1000 ||
          !Number.isSafeInteger(data.membershipsRegistered) ||
          data.membershipsRegistered < 0 ||
          data.membershipsRegistered > handLimit ||
          typeof data.membershipPending !== 'boolean')) ||
      (data.version === 3 &&
        (!Number.isSafeInteger(data.handsScanned) ||
          data.handsScanned < data.retiredHands ||
          data.handsScanned > handLimit ||
          typeof data.retirementPending !== 'boolean' ||
          typeof data.budgetReached !== 'boolean'))
    )
      return unknown();
    return Object.freeze({
      status: 'pruned' as const,
      completedWork: data.completedWork as number,
      batches: data.batches as number,
      observations: data.observations as number,
      ...(versioned
        ? {
            retiredHands: data.retiredHands as number,
            statisticsExpired: data.statisticsExpired as number,
            membershipsRegistered: data.membershipsRegistered as number,
            membershipPending: data.membershipPending as boolean,
          }
        : {}),
      ...(data.version === 3
        ? {
            handsScanned: data.handsScanned as number,
            retirementPending: data.retirementPending as boolean,
            budgetReached: data.budgetReached as boolean,
          }
        : {}),
    });
  } catch {
    // A committed prune may have lost its reply. Re-running is bounded and
    // safe, but counts cannot be guessed or accumulated for this attempt.
    return unknown();
  }
}
