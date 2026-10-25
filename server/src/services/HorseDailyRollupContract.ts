import { supabase } from './supabase/client.js';
import { reportError } from './errorReporter.js';

let contract: Promise<boolean> | undefined;

/** One startup-generation check, outside the action clock. An older database
 * keeps the existing writer; new payloads cannot be consumed by a projector
 * that ignores their daily aggregates. No polling or automatic repair. */
export function horseDailyRollupContract(): Promise<boolean> {
  return (contract ??= (async () => {
    try {
      // NULL never names a hand and cannot project or increment anything.
      // The installed owner advertises its additive response contract here;
      // old projectors return the same unavailable reason without the marker.
      const { data, error } = await supabase.rpc('ca_project_hand_stats_facts', {
        p_hand_id: null,
      });
      if (error || data?.horse_daily_rollups_contract !== 1) {
        reportError(
          new Error(error?.message ?? 'daily rollup contract is unavailable'),
          'HorseDailyRollupContract.legacyWriterRetained'
        );
        return false;
      }
      return true;
    } catch (error) {
      reportError(error, 'HorseDailyRollupContract.legacyWriterRetained');
      return false;
    }
  })());
}
