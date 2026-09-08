/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * ♠ CLUB ARENA — Centralized Member Count Utility
 * ═══════════════════════════════════════════════════════════════════════════════
 * Single source of truth for member count queries.
 * All queries filter by status IN ('active', 'approved') to exclude
 * banned, pending, and left members.
 *
 * Usage:
 *   import { getActiveMemberCount, getActiveMemberCountBatch } from '../utils/memberCount';
 *   const count = await getActiveMemberCount(clubId);
 *   const counts = await getActiveMemberCountBatch([id1, id2, id3]);
 */

import { supabase } from '../lib/supabase';
import { reportError } from './errorReporter';

/** Valid statuses for "active" members */
const ACTIVE_STATUSES = ['active', 'approved'] as const;

/**
 * Get LIVE active member count for a single club.
 * Filters by status IN ('active', 'approved').
 *
 * @param clubId - The resolved UUID of the club
 * @returns The count of active members (0 if error or empty)
 */
export async function getActiveMemberCount(clubId: string): Promise<number> {
  /*
   * A DIRECT club_members COUNT ANSWERS THE WRONG QUESTION.
   *
   * club_members carries four permissive SELECT policies. A viewer who is not a
   * member, admin, owner or union overseer of the club matches none of them, so
   * a direct count returns how many rows THAT VIEWER may enumerate - which is 0
   * - and not how many members the club has. Measured on production against a
   * club with 588 active members, as a real authenticated non-member:
   *
   *   direct count ................... 0
   *   fn_get_club_member_count ..... 588
   *
   * It is also ~370x slower, because the RLS filter runs a SECURITY DEFINER
   * function per row: 204.61 ms against 0.55 ms as the club owner.
   *
   * This file's header calls itself the single source of truth for member
   * counts, and it was not: this function disagreed with getActiveMemberCountBatch
   * below, which has always used the SECURITY DEFINER RPC family. Both now go
   * through the same definition, so the promise in the header is true.
   *
   * NOTE ON status: the RPC counts `status IS NULL OR status IN (...)` while this
   * function counted only the IN list. There are currently 0 rows with a NULL
   * status platform-wide, so the two agree today; adopting the RPC's rule makes
   * the whole family agree tomorrow as well.
   */
  try {
    const { data, error } = await supabase.rpc('fn_get_club_member_count', {
      p_club_id: clubId,
    });

    // bigint over PostgREST can arrive as a JSON number or a string.
    const count = data == null ? NaN : Number(data);
    if (!error && Number.isFinite(count)) {
      return count;
    }
  } catch (e) {
    reportError(e, 'memberCount.getActiveMemberCount');
    // Fall through
  }
  return 0;
}

/**
 * Get LIVE active member count for multiple clubs in a single query.
 * Uses the fn_batch_club_member_counts RPC (which also filters by status).
 * Falls back to individual queries if the RPC is not available.
 *
 * @param clubIds - Array of resolved club UUIDs
 * @returns Map of clubId → active member count
 */
export async function getActiveMemberCountBatch(clubIds: string[]): Promise<Map<string, number>> {
  const countMap = new Map<string, number>();

  if (clubIds.length === 0) return countMap;

  try {
    // Try batch RPC first (most efficient — 1 query for N clubs)
    const { data, error } = await supabase.rpc('fn_batch_club_member_counts', {
      p_club_ids: clubIds,
    });

    if (!error && data) {
      for (const row of data) {
        countMap.set(row.club_id, Number(row.member_count));
      }
      return countMap;
    }
  } catch (e) {
    reportError(e, 'memberCount.getActiveMemberCountBatch');
    // RPC not available — fall through to individual queries
  }

  // Fallback: individual queries (slower but always works)
  await Promise.all(
    clubIds.map(async (id) => {
      const count = await getActiveMemberCount(id);
      countMap.set(id, count);
    })
  );

  return countMap;
}

/**
 * Get the count of clubs a user actively belongs to.
 * Used for the 4-club membership limit check.
 * Filters by active/approved status so bans don't count against the limit.
 *
 * @param userId - The user's UUID
 * @returns The count of active club memberships
 */
export async function getUserActiveClubCount(userId: string): Promise<number> {
  try {
    const { count, error } = await supabase
      .from('club_members')
      .select('user_id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .in('status', [...ACTIVE_STATUSES]);

    if (!error && typeof count === 'number') {
      return count;
    }
  } catch (e) {
    reportError(e, 'memberCount.getUserActiveClubCount');
    // Fall through
  }
  return 0;
}
