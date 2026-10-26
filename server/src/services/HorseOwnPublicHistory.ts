import { supabase } from './supabase/client.js';
import {
  horseObserverReadContextIsValid,
  horseObserverReadContextKey,
  type HorseObserverReadContext,
} from '../engine/HorseObserverReadContext.js';
import { noteFire } from '../engine/BrainTelemetry.js';

// Native PG17 qualification checks this against the exact installed function.
export const HORSE_OWN_PUBLIC_HISTORY_DEFINITION_MD5 = '9106fc84c02669f38f554af45db6d867';
/**
 * How long the engine waits for one horse's history before giving up on it.
 *
 * Measured live 2026-10-26 01:06-01:55 UTC, the first hour after this reader
 * shipped: 6,692 calls reached the database and every one answered 200, the
 * slowest in 1,330 ms (p50 46 ms, p99 613 ms). Over the same hour the engine
 * gave up on roughly a quarter of them at the old 1,500 ms deadline, and a
 * context that gives up is not asked again for the life of the process, so
 * that horse played that game type without its own history. The time was
 * lost between the engine and the database, not inside the query.
 *
 * Nothing waits on this read: the turn never blocks on it, and a load only
 * holds one of the cache's 16 slots. So the deadline is sized like the
 * engine's other non-blocking calls (SEEDING_DB_TIMEOUT_MS, 5 s), not like a
 * hand-path call. The three failure fires below say which way a load failed.
 */
export const HORSE_OWN_PUBLIC_HISTORY_TIMEOUT_MS = 5_000;
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
      .abortSignal(AbortSignal.timeout(HORSE_OWN_PUBLIC_HISTORY_TIMEOUT_MS));
    if (error || !data || typeof data !== 'object' || Array.isArray(data)) {
      noteFire('horse_observer_history_unavailable');
      noteFire(error ? 'horse_observer_history_error' : 'horse_observer_history_empty_response');
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
    noteFire('horse_observer_history_thrown');
    return null;
  }
}
