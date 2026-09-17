import { supabase } from './supabase.js';
import { parseJournalQueueHealth } from './horseAdaptiveJournal/queueHealth.js';
import { parseCaptureQueueHealth } from './horseAdaptiveJournal/captureHealth.js';

/** One bounded database snapshot/transport budget for both independent queues. */
export async function readLearningQueueHealth() {
  try {
    const { data, error } = await supabase
      .rpc('fn_horse_learning_work_health')
      .abortSignal(AbortSignal.timeout(5000));
    const valid = !error && data?.version === 1;
    return Object.freeze({
      journal: parseJournalQueueHealth(valid ? data.journal : null),
      capture: parseCaptureQueueHealth(valid ? data.capture : null),
    });
  } catch {
    return Object.freeze({
      journal: parseJournalQueueHealth(null),
      capture: parseCaptureQueueHealth(null),
    });
  }
}
