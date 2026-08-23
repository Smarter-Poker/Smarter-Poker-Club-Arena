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
 * PRECEDENCE
 *   1. display_name_preference, when the field it names actually holds a value
 *   2. use_real_name -> the real name, else the handle
 *   3. alias -> username -> display_name -> full_name, first non-blank
 *   4. 'Player'
 *
 * `display_name` sits deliberately LOW. It is the one column in this table with
 * no clear owner: some rows have a real chosen name in it, others (like Dan's)
 * carry seed data nobody set. Anything the player explicitly typed or picked
 * outranks it.
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

/**
 * What to call this player, everywhere.
 *
 * Never returns an empty string, so a caller can render it directly without
 * its own `|| 'Player'` - which is exactly how the divergence started.
 */
export function playerDisplayName(p: NameableProfile | null | undefined): string {
  if (!p) return FALLBACK;

  /* 1. An explicit preference wins, but only if the column it points at
        actually holds something. A preference of `full_name` on a profile with
        no name set must not render blank. */
  const pref = clean(p.display_name_preference);
  if (pref) {
    const byPref: Record<string, string | null> = {
      full_name: realName(p),
      real_name: realName(p),
      alias: clean(p.alias),
      username: clean(p.username),
      display_name: clean(p.display_name),
    };
    const chosen = byPref[pref];
    if (chosen) return chosen;
  }

  // 2. The older boolean, still set on plenty of rows.
  if (p.use_real_name === true) {
    const real = realName(p);
    if (real) return real;
  }

  // 3. What the player typed, then what they were assigned.
  return handleName(p) || clean(p.display_name) || realName(p) || FALLBACK;
}

/** The columns a query must select for playerDisplayName() to work. */
export const PLAYER_NAME_COLUMNS =
  'username, display_name, alias, first_name, last_name, full_name, display_name_preference, use_real_name';
