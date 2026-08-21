/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  SPIN TIER AVAILABILITY — "is the 100x actually on the wheel right now?"
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Reads `v_spin_tier_availability`, the deliberately tiny public view over the
 * Reserve Pool: one boolean per club (can_draw_100x) and nothing that lets a
 * reader recover the pool's balance. It uses the same jackpot-threshold
 * arithmetic as the draw itself, so what a lobby badge advertises is what the
 * wheel will actually offer.
 *
 * It was two booleans until 2026-08-21, when the 500x was retired and the view
 * dropped `can_draw_500x`. A stale bundle still asking for that column gets a
 * PostgREST error, which lands in the `error` branch below and simply keeps the
 * previous cache: the badge disappears, nothing breaks.
 *
 * Everything else about the reserve is service-role only, on purpose. If a
 * surface needs more than these two bits, that is a conversation about the
 * view, never a reason to widen a table grant.
 *
 * One request per lobby render, not one per card: a lobby shows many Spin
 * tiles for the same club, so the fetch is module-cached with a short TTL and
 * shared across every subscriber. The pool moves with every settled game, but
 * a 60-second-stale badge is fine — the DRAW is still gated server-side, so a
 * stale "100x live" can never produce an unpayable jackpot, only a moment of
 * optimism.
 */

import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';

export interface SpinTierAvailability {
  can_draw_100x: boolean;
}

const TTL_MS = 60_000;

let cache: Map<string, SpinTierAvailability> = new Map();
let fetchedAt = 0;
let inflight: Promise<void> | null = null;

async function refresh(): Promise<void> {
  if (Date.now() - fetchedAt < TTL_MS) return;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const { data, error } = await supabase
        .from('v_spin_tier_availability')
        .select('club_id, can_draw_100x');
      if (error || !Array.isArray(data)) return; // keep the old cache — stale beats wrong-empty
      const next = new Map<string, SpinTierAvailability>();
      for (const row of data) {
        if (row?.club_id) {
          next.set(String(row.club_id), {
            can_draw_100x: !!row.can_draw_100x,
          });
        }
      }
      cache = next;
      fetchedAt = Date.now();
    } catch {
      /* badge is decoration; a fetch failure must never mark a lobby */
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/**
 * Availability for one club, or null while unknown. Null renders as "no
 * badge", which is the correct failure mode: an absent boast, never a wrong
 * one.
 */
export function useSpinTierAvailability(
  clubId: string | null | undefined
): SpinTierAvailability | null {
  const [value, setValue] = useState<SpinTierAvailability | null>(() =>
    clubId ? (cache.get(String(clubId)) ?? null) : null
  );

  useEffect(() => {
    if (!clubId) return;
    let cancelled = false;
    void refresh().then(() => {
      if (!cancelled) setValue(cache.get(String(clubId)) ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [clubId]);

  return value;
}
