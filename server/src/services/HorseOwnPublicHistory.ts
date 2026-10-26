import { supabase } from './supabase/client.js';
import {
  horseObserverReadContextIsValid,
  horseObserverReadContextKey,
  type HorseObserverReadContext,
} from '../engine/HorseObserverReadContext.js';
import { noteFire } from '../engine/BrainTelemetry.js';

// Native PG17 qualification checks this against the exact installed function.
export const HORSE_OWN_PUBLIC_HISTORY_DEFINITION_MD5 = '9106fc84c02669f38f554af45db6d867';
/** A read of already accepted public hands only. Caller stamps availability
 * after resolution; this SQL cutoff alone never proves earlier visibility. */
export async function readHorseOwnPublicHistory(
  context: HorseObserverReadContext
): Promise<unknown> {
  if (!horseObserverReadContextIsValid(context)) return null;
  try {
    const { data, error } = await supabase
      .rpc('fn_horse_own_public_history_read', {
        p_observer: context.observerId,
        p_variant: context.variant,
        p_format: context.format,
        p_dealt_count: context.dealtCount,
        p_before: new Date().toISOString(),
      })
      .abortSignal(AbortSignal.timeout(1500));
    if (error || !data || typeof data !== 'object' || Array.isArray(data)) {
      noteFire('horse_observer_history_unavailable');
      return null;
    }
    if (
      Object.keys(data).length !== 2 ||
      data.definitionMd5 !== HORSE_OWN_PUBLIC_HISTORY_DEFINITION_MD5 ||
      !data.window ||
      horseObserverReadContextKey(data.window.context) !== horseObserverReadContextKey(context)
    ) {
      noteFire('horse_observer_history_source_mismatch');
      return null;
    }
    return data.window;
  } catch {
    noteFire('horse_observer_history_unavailable');
    return null;
  }
}
