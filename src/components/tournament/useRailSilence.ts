/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  WHEN THE RAIL MUST NOT SPEAK (2026-09-13)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * This strip exists to sell. Its strongest line is literally
 *
 *     "8,400 Overlay Right Now . Last Level Of Late Registration . Jump In Now"
 *
 * pinned above the felt, on a thirty-second loop. There are two states in which
 * a surface like that has to go quiet, and until now it knew about neither.
 *
 * ── 1. A PLAYER WHO ASKED TO BE STOPPED ────────────────────────────────────
 *
 * The estate has a responsible-gaming system: the World Hub exposes
 * /api/rg/self-exclude, /api/rg/limits and the session and reality-check
 * routes, and the database carries `responsible_gaming_limits` with
 * `self_excluded_until` and `cooling_off_until`.
 *
 * Club Arena referenced none of it. Not the rail, not registration, not the
 * cashier. A player who self-excluded through the World Hub still got this bar.
 *
 * The check is `fn_rg_require_not_excluded`, and until the migration that ships
 * beside this file it ANSWERED THE WRONG THING - see
 * 20260913172658_a_player_can_see_their_own_responsible_gaming_state.sql. It is
 * STABLE and not SECURITY DEFINER, and the limits table had no policy admitting
 * the user a row is about, so the player's own row was invisible to the player
 * and the function's "no row means no limits" branch turned that into `ok`.
 * Proven in a rolled-back transaction: the house saw `self_excluded`, the
 * player's own client saw `{"ok": true, "reason": "no_limits_set"}`.
 *
 * So this hook is only honest with that migration applied. That is why they
 * ship together.
 *
 * ── 2. THE HOUSE IS CLOSED ─────────────────────────────────────────────────
 *
 * There is an hourly maintenance break: the engine announces it, dies in the
 * middle of it, and `useMaintenanceBreak` keeps the countdown honest across the
 * outage from three independent sources. During it, tables are frozen.
 *
 * The rail had four references to the word "maintenance" and every one of them
 * was the OPERATOR'S service-notice source. It did not know the platform freeze
 * existed, so at :55 it could count "Starts In 0:12" toward an event that
 * cannot start, and say "Jump In Now" about a table nobody can join. The break
 * owns a banner and a full screen; the rail defers to both.
 *
 * ── WHAT AN UNKNOWN ANSWER MEANS, AND WHY ──────────────────────────────────
 *
 * `SPEAK_WHEN_UNKNOWN` is the whole policy, in one constant, deliberately.
 *
 * A failed read is not a "no". Failing closed would silence the rail for every
 * player on this platform during any Supabase blip, which costs real
 * announcements; failing open shows an advertisement to someone who might have
 * asked not to see one. Today the limits table holds zero rows - nobody has
 * ever set a limit - and the answer is re-read on every poll, so an unknown
 * state lasts seconds. On that evidence the open default is right.
 *
 * It is one line to flip when the first player self-excludes and that evidence
 * changes, and it is written here rather than buried so the flip is a decision
 * somebody makes on purpose.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { reportError } from '../../utils/errorReporter';
import { useMaintenanceBreak } from '../../hooks/useMaintenanceBreak';
import { useMasterBusSubscription } from '../../hooks/useMasterBusSubscription';

/** See the header. The policy for a read that did not come back. */
export const SPEAK_WHEN_UNKNOWN = true;

export type SilenceReason = 'self_excluded' | 'cooling_off' | 'maintenance_break' | null;

export interface RailSilence {
  /** True when the bar must say nothing at all. */
  silent: boolean;
  /** Why, for the log and for a test. Never shown to a player. */
  reason: SilenceReason;
}

/**
 * The answer, per user, for as long as the tab lives.
 *
 * Module scope rather than component state because the rail unmounts on every
 * route that is not a table or a club lobby, and a player walking between them
 * should not re-ask a question whose answer changes about once a year.
 */
const cache = new Map<string, { ok: boolean; reason: SilenceReason }>();

/** Test seam. */
export function resetRailSilenceCache(): void {
  cache.clear();
}

interface RequireNotExcluded {
  ok?: boolean;
  error?: string;
}

export function useRailSilence(): RailSilence {
  const { maintenanceBreak } = useMaintenanceBreak();
  const [gaming, setGaming] = useState<{ ok: boolean; reason: SilenceReason }>({
    ok: SPEAK_WHEN_UNKNOWN,
    reason: null,
  });
  const userRef = useRef<string | null>(null);

  const read = useCallback(async () => {
    let uid: string | null = null;
    try {
      const auth = await import('../../lib/authUtils').then((m) => m.readLocalSession());
      uid = auth?.userId || null;
    } catch {
      uid = null;
    }
    userRef.current = uid;

    /* Signed out is not excluded. The rail is only mounted behind a session
       anyway; this is the honest answer rather than a silent one. */
    if (!uid) {
      setGaming({ ok: true, reason: null });
      return;
    }

    const cached = cache.get(uid);
    if (cached) {
      setGaming(cached);
      return;
    }

    try {
      const { data, error } = await supabase.rpc('fn_rg_require_not_excluded', {
        p_user_id: uid,
      });
      if (error) throw error;
      const answer = (data || {}) as RequireNotExcluded;
      const next =
        answer.ok === false
          ? {
              ok: false,
              reason: (answer.error === 'cooling_off'
                ? 'cooling_off'
                : 'self_excluded') as SilenceReason,
            }
          : { ok: true, reason: null as SilenceReason };
      cache.set(uid, next);
      setGaming(next);
    } catch (e) {
      reportError(e, 'useRailSilence.requireNotExcluded');
      /* NOT cached: an unknown answer must be asked again, not remembered. */
      setGaming({ ok: SPEAK_WHEN_UNKNOWN, reason: null });
    }
  }, []);

  useEffect(() => {
    void read();
  }, [read]);

  /* A different person is a different answer. */
  useMasterBusSubscription('AUTH_STATE_CHANGED', () => {
    if (userRef.current) cache.delete(userRef.current);
    void read();
  });

  if (maintenanceBreak.active) {
    return { silent: true, reason: 'maintenance_break' };
  }
  if (!gaming.ok) {
    return { silent: true, reason: gaming.reason };
  }
  return { silent: false, reason: null };
}

export default useRailSilence;
