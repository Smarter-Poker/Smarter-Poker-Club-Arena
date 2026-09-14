import { supabase } from './supabase.js';
import {
  parseDiscoveryReceipt,
  unknownDiscovery,
} from './horseAdaptiveJournal/discoveryReceipt.js';

/** One atomic, bounded intake step. A lost committed reply remains unknown;
 * the database owns the original epoch, frozen actors and admission cursor. */
export async function discoverObservationRequests() {
  try {
    const { data, error } = await supabase
      .rpc('fn_discover_horse_observation_requests')
      .abortSignal(AbortSignal.timeout(5000));
    return error ? unknownDiscovery() : parseDiscoveryReceipt(data);
  } catch {
    return unknownDiscovery();
  }
}

/** Terminal successful discovery history only. Unresolved source gaps and
 * pending memberships are never retired by this maintenance pass. */
export async function pruneObservationDiscovery() {
  const unknown = () => Object.freeze({ status: 'unknown' as const });
  try {
    const { data, error } = await supabase
      .rpc('fn_prune_horse_observation_discovery')
      .abortSignal(AbortSignal.timeout(5000));
    if (
      error ||
      data?.version !== 1 ||
      data.status !== 'pruned' ||
      ![data.epochs, data.members, data.segments].every((n) => Number.isSafeInteger(n) && n >= 0) ||
      data.epochs > 1 ||
      data.members > 512 ||
      data.segments > 128
    )
      return unknown();
    return Object.freeze({
      status: 'pruned' as const,
      epochs: data.epochs as number,
      members: data.members as number,
      segments: data.segments as number,
    });
  } catch {
    return unknown();
  }
}
