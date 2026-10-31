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
 * a badge expires after 60 seconds. Focus and visibility recovery can request
 * a new observation; expiry only hides the old claim and never polls the pool.
 * The draw remains gated by its server-side funding authority.
 */

import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { reportError } from '../utils/errorReporter';
import { runWithRequestDeadline } from '../utils/requestDeadline';

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
      const { data, error } = await runWithRequestDeadline((signal) =>
        supabase
          .from('v_spin_tier_availability')
          .select('club_id, can_draw_100x')
          .abortSignal(signal)
      );
      if (error) {
        reportError(error, 'SpinTierAvailability.read');
        return; // keep the prior club-scoped cache
      }
      if (!Array.isArray(data)) return;
      const next = new Map<string, SpinTierAvailability>();
      for (const row of data) {
        if (row?.club_id && typeof row.can_draw_100x === 'boolean') {
          next.set(String(row.club_id), {
            can_draw_100x: row.can_draw_100x,
          });
        }
      }
      cache = next;
      fetchedAt = Date.now();
    } catch (error) {
      reportError(error, 'SpinTierAvailability.read');
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
  const key = clubId ? String(clubId) : null;
  const current = () => ({
    clubId: key,
    value: key && Date.now() - fetchedAt < TTL_MS ? (cache.get(key) ?? null) : null,
    expiresAt: fetchedAt + TTL_MS,
  });
  const [snapshot, setSnapshot] = useState(current);

  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    let expiry: ReturnType<typeof setTimeout> | undefined;
    const publish = () => {
      if (cancelled) return;
      clearTimeout(expiry);
      const remaining = fetchedAt + TTL_MS - Date.now();
      setSnapshot({
        clubId: key,
        value: remaining > 0 ? (cache.get(key) ?? null) : null,
        expiresAt: fetchedAt + TTL_MS,
      });
      // One display expiry, not a read/retry loop. No stale "Live" claim is
      // retained after its evidence expires, even if the next read fails.
      if (remaining > 0)
        expiry = setTimeout(() => {
          if (!cancelled) setSnapshot({ clubId: key, value: null, expiresAt: 0 });
        }, remaining);
    };
    const read = () => {
      publish();
      void refresh().then(publish);
    };
    const visible = () => {
      if (document.visibilityState === 'visible') read();
    };
    read();
    window.addEventListener('focus', read);
    document.addEventListener('visibilitychange', visible);
    return () => {
      cancelled = true;
      clearTimeout(expiry);
      window.removeEventListener('focus', read);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [key]);

  // A changed club is a new question, including the render before its effect.
  return key && snapshot.clubId === key && Date.now() < snapshot.expiresAt ? snapshot.value : null;
}
