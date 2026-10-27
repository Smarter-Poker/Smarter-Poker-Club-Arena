import { supabase } from './supabase.js';
import {
  validOpponentProfile,
  type DurableOpponentProfile,
} from '../engine/HorseOpponentMemory.js';

export interface HorsePooledPublicBootstrap {
  availableAtMs: number;
  profiles: DurableOpponentProfile[];
}
/** One finite saved-only boot read before READY, not a turn request, history
 * backfill, initializer or watcher. A capped/failed/inconsistent read supplies
 * no bootstrap; accepted-hand public updates can still warm the cache. */
export async function readHorsePooledPublicBootstrap(): Promise<HorsePooledPublicBootstrap | null> {
  const profiles: DurableOpponentProfile[] = [];
  const seen = new Set<string>();
  const deadline = AbortSignal.timeout(5000);
  try {
    for (let offset = 0; offset <= 20000; offset += 1000) {
      const { data, error } = await supabase
        .from('horse_exploit_profiles')
        .select('user_id,variant,mode,size,counters,observed_hands,initialized')
        .order('user_id')
        .order('variant')
        .order('mode')
        .order('size')
        .range(offset, offset + 999)
        .abortSignal(deadline);
      if (error || !Array.isArray(data) || data.length > 1000) return null;
      for (const row of data) {
        if (!validOpponentProfile(row)) return null;
        const key = JSON.stringify([row.user_id, row.variant, row.mode, row.size]);
        if (seen.has(key) || profiles.length >= 20000) return null;
        seen.add(key);
        profiles.push(row);
      }
      if (data.length < 1000) return { availableAtMs: Date.now(), profiles };
    }
  } catch {
    /* unavailable remains distinct from an empty successful read */
  }
  return null;
}
