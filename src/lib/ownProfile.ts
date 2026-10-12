/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A PROFILE SHOWS STRANGERS ONLY WHAT THE TABLE NEEDS (ruling 25)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Decided by Claude on Dan's delegation of 2026-09-30 ("these are all for you
 * to decide not me ... FIX AND FINISH ALL OF THESE"), docs/DIAMOND-RULINGS.md
 * ruling 25: a stranger sees only what playing with you needs - display name,
 * username, avatar, player number and public statistics. Anything that
 * reveals a person's money, real identity or whereabouts is readable only by
 * that person and by platform staff.
 *
 * So `authenticated` holds no SELECT on the columns below
 * (migration 20260930234500), and Postgres refuses a WHOLE statement that
 * names one of them - in the select list, in a filter, in an order, or in an
 * upsert (ON CONFLICT DO UPDATE reads the column it sets) - with 42501. That
 * includes the owner's own row: a column grant is not per row. Three doors
 * replace the reads (migration 20260930234000):
 *
 *   ownProfile(id)          the signed-in player's own row, every column,
 *                           through get_my_full_profile() (the caller's row
 *                           and nothing else). Filtered by id, so a caller
 *                           that passes somebody else's id gets no row
 *                           rather than their own.
 *   readPresence(ids)       who is online now, a boolean per account, through
 *                           fn_profile_presence() - never the heartbeat.
 *   (staff)                 get_full_profiles_for_staff(ids), platform staff
 *                           only. Nothing in the Club Arena needs it today.
 *
 * Writes are unchanged: UPDATE on these columns is still granted, so the
 * owner edits their own row with `.update(...).eq('id', id)` as before.
 */
import { supabase } from './supabase';

/** The columns of public.profiles only their owner and platform staff read. */
export const PRIVATE_PROFILE_COLUMNS = [
  'diamonds',
  'diamond_balance',
  'diamond_multiplier',
  'first_name',
  'last_name',
  'full_name',
  'birth_year',
  'city',
  'state',
  'country',
  'last_seen',
  'last_login',
  'last_login_date',
  'last_active',
  'updated_at',
  'referred_by',
  'poker_near_me_preferences',
] as const;

/** The owner door: the signed-in player's own profile row, filtered by id. */
export function ownProfile(userId: string) {
  return supabase.rpc('get_my_full_profile').eq('id', userId);
}

/**
 * Who of these accounts is online now: the persisted flag counted only while
 * its heartbeat is under five minutes old (SOCIAL_PRESENCE_FRESH_MS). An
 * account that cannot be read is simply absent from the map, which callers
 * treat as offline - the honest default.
 */
export async function readPresence(userIds: readonly string[]): Promise<Map<string, boolean>> {
  const online = new Map<string, boolean>();
  const ids = [...new Set(userIds.filter(Boolean))];
  for (let i = 0; i < ids.length; i += 500) {
    const { data, error } = await supabase.rpc('fn_profile_presence', {
      p_user_ids: ids.slice(i, i + 500),
    });
    if (error) throw error;
    for (const row of (data || []) as { user_id: string; is_online: boolean }[]) {
      online.set(row.user_id, row.is_online === true);
    }
  }
  return online;
}
