import { supabase } from './supabase.js';
import { ADAPTIVE_JOURNAL_LIMITS } from './HorseAdaptiveObservationJournal.js';
import {
  parseJournalQueueHealth,
  type JournalQueueHealth,
} from './horseAdaptiveJournal/queueHealth.js';

export async function readJournalQueueHealth(): Promise<JournalQueueHealth> {
  try {
    const { data, error } = await supabase
      .rpc('fn_horse_adaptive_journal_work_health')
      .abortSignal(AbortSignal.timeout(ADAPTIVE_JOURNAL_LIMITS.timeoutMs));
    return error ? Object.freeze({ status: 'unknown' }) : parseJournalQueueHealth(data);
  } catch {
    return Object.freeze({ status: 'unknown' });
  }
}
