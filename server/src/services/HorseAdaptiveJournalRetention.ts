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
    if (error || data?.version !== 1) return unknown();
    if (data.status === 'unavailable' && data.reason === 'capacity_busy')
      return Object.freeze({ status: 'unavailable' as const, reason: 'capacity_busy' });
    if (
      data.status !== 'pruned' ||
      ![data.completedWork, data.batches, data.observations].every(
        (n) => Number.isSafeInteger(n) && n >= 0
      ) ||
      data.completedWork > 100 ||
      data.batches > 100 ||
      data.observations > 1000
    )
      return unknown();
    return Object.freeze({
      status: 'pruned' as const,
      completedWork: data.completedWork as number,
      batches: data.batches as number,
      observations: data.observations as number,
    });
  } catch {
    // A committed prune may have lost its reply. Re-running is bounded and
    // safe, but counts cannot be guessed or accumulated for this attempt.
    return unknown();
  }
}
