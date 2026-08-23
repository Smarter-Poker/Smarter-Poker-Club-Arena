/**
 * ONE ANSWER TO "WHAT DO WE CALL THIS PLAYER".
 *
 * Dan, 2026-08-23: "FIX WHAT EVER IS CAUSING IT TO CALL ME 'MARCUS CHEN'
 * INSTEAD OF KINGFISH OR DAN BEKAVAC".
 *
 * WHAT WAS ACTUALLY WRONG
 *
 * Nothing had decided what a player is called, so every screen decided for
 * itself. A dozen call sites each wrote their own `a || b || 'Player'` chain in
 * a different order, and NONE of them read the preference the player had
 * already set. Dan's own row is the perfect illustration:
 *
 *     username                 kingfish
 *     display_name             Marcus Chen     <- stale seed data
 *     alias                    KingFish
 *     full_name                Dan Bekavac
 *     display_name_preference  full_name       <- what he actually asked for
 *     use_real_name            false
 *
 * The poker table reached for `username` and said "kingfish". The tournament
 * ranking card reached for `display_name` and said "Marcus Chen" - a name from
 * seed data that belongs to nobody. The settings screen let him pick
 * `full_name` and then nothing consulted it. Three surfaces, three answers, one
 * player.
 *
 * So this is the resolver, and the preference is the FIRST thing it reads. A
 * player who has chosen how to be addressed should not be overruled by
 * whichever column a given screen happened to grab.
 *
 * CONTEXT DECIDES, 2026-08-23
 *
 * Dan: "IM DAN BEKAVAC ON SOCIAL AND KINGFISH IN THE CLUB ARENA. NOTHING ELSE."
 *
 * So a player has TWO names and the surface picks, rather than one name fought
 * over by five columns:
 *
 *   arena  - the handle. alias -> username. A real name is NEVER shown here,
 *            whatever the profile says. That is not only Dan's preference: a
 *            poker table is a pseudonymous space, and printing somebody's legal
 *            name next to their stack is a privacy leak nobody asked for.
 *   social - the person. The real name IF they allow it, else the handle.
 *
 * `display_name` is last in both. It is the one column here with no clear
 * owner - and on 2026-08-23 it was found holding "Marcus Chen", the name of a
 * row in ai_horses, on a real human account. A column that can carry an AI
 * player's identity onto a person is not a column to trust first.
 *
 * The database now refuses that write as well: see the trigger
 * trg_reject_horse_name_on_human, added in
 * supabase/migrations/*_strip_horse_names_from_human_profiles.sql.
 */

export interface NameableProfile {
  username?: string | null;
  display_name?: string | null;
  alias?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  full_name?: string | null;
  display_name_preference?: string | null;
  use_real_name?: boolean | null;
}

const FALLBACK = 'Player';

/**
 * Which surface is asking.
 *
 * Defaults to 'arena' everywhere in THIS repo, because this repo IS the Club
 * Arena - a caller that forgets to pass a context gets the pseudonymous answer,
 * which is the safe direction to be wrong in.
 */
export type NameContext = 'arena' | 'social';

/** Trim, and treat blank / whitespace-only as absent. */
function clean(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

/** The player's real name, assembled from whatever parts exist. */
export function realName(p: NameableProfile | null | undefined): string | null {
  if (!p) return null;
  const full = clean(p.full_name);
  if (full) return full;
  const parts = [clean(p.first_name), clean(p.last_name)].filter(Boolean);
  return parts.length ? parts.join(' ') : null;
}

/** The handle a player is known by at the tables. */
export function handleName(p: NameableProfile | null | undefined): string | null {
  if (!p) return null;
  return clean(p.alias) || clean(p.username) || null;
}

/** True when the player has asked to be shown by their real name on social. */
function wantsRealName(p: NameableProfile): boolean {
  const pref = clean(p.display_name_preference);
  if (pref) return pref === 'full_name' || pref === 'real_name';
  return p.use_real_name === true;
}

/**
 * What to call this player on a given surface.
 *
 * Never returns an empty string, so a caller can render it directly without its
 * own `|| 'Player'` - which is exactly how the divergence started.
 */
export function playerDisplayName(
  p: NameableProfile | null | undefined,
  context: NameContext = 'arena'
): string {
  if (!p) return FALLBACK;

  if (context === 'arena') {
    /* Handle only. Deliberately ignores display_name_preference: a player who
       set "full name" for their social profile has not thereby asked for their
       legal name to appear at a poker table. */
    return handleName(p) || clean(p.display_name) || FALLBACK;
  }

  if (wantsRealName(p)) {
    const real = realName(p);
    if (real) return real; // ...but never render blank if they never set one
  }
  return handleName(p) || clean(p.display_name) || realName(p) || FALLBACK;
}

/** The columns a query must select for playerDisplayName() to work. */
export const PLAYER_NAME_COLUMNS =
  'username, display_name, alias, first_name, last_name, full_name, display_name_preference, use_real_name';
