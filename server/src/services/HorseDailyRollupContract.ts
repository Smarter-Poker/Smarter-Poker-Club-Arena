import { supabase } from './supabase/client.js';
import { reportError } from './errorReporter.js';

let contract: Promise<boolean> | undefined;

/** One startup-generation check, outside the action clock. An older database
 * keeps the existing writer; new payloads cannot be consumed by a projector
 * that ignores their daily aggregates. No polling or automatic repair. */
export function horseDailyRollupContract(): Promise<boolean> {
  return (contract ??= (async () => {
    try {
      const { data, error } = await supabase.rpc('fn_horse_daily_rollup_contract');
      if (error || data !== 1) {
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
