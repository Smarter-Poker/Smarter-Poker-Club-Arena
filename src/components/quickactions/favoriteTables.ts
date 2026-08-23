/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  FAVOURITE TABLES — the shared id-only read of `favorite_tables`
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-23: "'quick join' should be users favorite games, or similar
 * games to the one they are playing."
 *
 * WHY THIS FILE EXISTS. Favourites already had exactly one reader:
 * `FavoriteTablesWidget.loadFavorites`, a closure inside the component that
 * joins `tables` and `clubs` to draw a row. Quick Join needs the same fact
 * ("which tables has this user starred?") and none of the display join, and it
 * cannot call a closure. The alternative was a second favourites query written
 * from scratch in MultiTablePage — which is how a codebase ends up with two
 * favourites concepts that disagree. This is the shared read; the widget's
 * richer query stays as it is for its own row rendering.
 *
 * Never throws. Quick Join has to open in a few hundred milliseconds whatever
 * happens, and "no favourites" degrades the ranking to similar-games-first,
 * which is still a correct sheet. A rejected promise here would take the whole
 * sheet down to the lobby-tab fallback.
 */

import { supabase } from '../../lib/supabase';
import { reportError } from '../../utils/errorReporter';

/**
 * `favorite_tables.table_id` for one user, deduped.
 *
 * Returns [] for a signed-out user, an empty favourites list, or any failure —
 * the caller cannot tell them apart and does not need to.
 */
export async function fetchFavoriteTableIds(userId: string | null | undefined): Promise<string[]> {
  if (!userId) return [];
  try {
    /* Multi-row select, so neither .single() nor .maybeSingle() applies: those
       are for reads that must yield exactly one row. */
    const { data, error } = await supabase
      .from('favorite_tables')
      .select('table_id')
      .eq('user_id', userId);

    if (error) {
      reportError(error, 'favoriteTables.fetchFavoriteTableIds');
      return [];
    }

    const ids = (data || [])
      .map((row: { table_id?: string | null }) => row?.table_id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);

    return Array.from(new Set(ids));
  } catch (err) {
    reportError(err, 'favoriteTables.fetchFavoriteTableIds');
    return [];
  }
}

export default fetchFavoriteTableIds;
