/**
 * useStatsPulse - the stats page's heartbeat (Stats Page Programme phase 3).
 *
 * WHY NOT REALTIME
 * ----------------
 * The page's "live from any tab" used to be a postgres_changes subscription
 * on ca_hand_player_idx. On 2026-09-04 that table left the realtime
 * publication, correctly: it is 4.5 million inserts a day decoded out of WAL
 * for an audience of one page that is rarely open, and the replication slot
 * was 136 MB behind. From that moment the subscription could never fire, and
 * a player grinding in one tab with Stats open in another was back to seeing
 * nothing move.
 *
 * The right shape is the opposite one: the open page asks. ca_player_stats_pulse
 * is two index probes (the player's newest hand, a fingerprint of their
 * tournament rows), owner-asserted, 157 ms measured, and this hook calls it
 * every `intervalMs` while the document is visible. Cost scales with open
 * stats pages, not with hands dealt anywhere. It also covers tournament
 * finishes, which a hand index never could.
 *
 * WHAT IT OWNS
 *   - polling: only while `enabled` and the document is visible. A hidden tab
 *     costs nothing;
 *   - the tab return: this hook replaces useVisibilityRefresh on the stats
 *     page so a return costs ONE refetch, never two. Away for less than
 *     `staleAfterMs`: poll at once and refetch only if the pulse moved. Away
 *     for longer: refetch regardless (the analysis window's boundary has
 *     moved and the "updated" readout is owed a fresh time), and take the next
 *     sample as the new baseline so the same hands are not fetched twice;
 *   - the first sample is a baseline, never a change;
 *   - a changed pulse calls `onChange` once; the caller debounces the refetch;
 *   - a failed poll is reported once and retried on the next tick, never
 *     surfaced to the player (the bus still carries same-tab hands).
 */
import { useEffect, useRef } from 'react';
import { supabase } from '../lib/supabase';
import { reportError } from '../utils/errorReporter';

export const STATS_PULSE_INTERVAL_MS = 8_000;
/** A return after this long away refetches even if the pulse did not move. */
export const STATS_PULSE_STALE_AFTER_MS = 30_000;

export interface StatsPulseOptions {
  userId: string | null | undefined;
  enabled: boolean;
  onChange: () => void;
  intervalMs?: number;
  staleAfterMs?: number;
}

/** Reads the `pulse` string out of the RPC payload; null when unusable. */
export function pulseOf(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = (payload as { pulse?: unknown }).pulse;
  return typeof p === 'string' ? p : null;
}

export function useStatsPulse({
  userId,
  enabled,
  onChange,
  intervalMs = STATS_PULSE_INTERVAL_MS,
  staleAfterMs = STATS_PULSE_STALE_AFTER_MS,
}: StatsPulseOptions): void {
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  });

  useEffect(() => {
    if (!enabled || !userId) return;
    let last: string | null = null;
    let inFlight = false;
    let reported = false;
    let hiddenAt: number | null = null;
    let cancelled = false;

    const tick = async () => {
      if (cancelled || inFlight || document.visibilityState !== 'visible') return;
      inFlight = true;
      try {
        const { data, error } = await supabase.rpc('ca_player_stats_pulse', { p_user: userId });
        if (cancelled) return;
        if (error) throw new Error(error.message);
        const pulse = pulseOf(data);
        if (pulse === null) return;
        if (last === null) {
          last = pulse; // baseline
        } else if (pulse !== last) {
          last = pulse;
          onChangeRef.current();
        }
      } catch (err) {
        if (!reported) {
          reported = true;
          reportError(err, 'useStatsPulse.rpc_ca_player_stats_pulse');
        }
      } finally {
        inFlight = false;
      }
    };

    const onVisibility = () => {
      if (document.visibilityState !== 'visible') {
        hiddenAt = Date.now();
        return;
      }
      const away = hiddenAt === null ? 0 : Date.now() - hiddenAt;
      hiddenAt = null;
      if (away >= staleAfterMs) {
        // One refetch for the return; the next sample is the new baseline.
        last = null;
        onChangeRef.current();
      }
      void tick();
    };

    void tick();
    const timer = setInterval(() => void tick(), intervalMs);
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [userId, enabled, intervalMs, staleAfterMs]);
}
