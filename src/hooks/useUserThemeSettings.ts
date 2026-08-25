/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * useUserThemeSettings — Bible V8 §11.2 Theme Persistence Hook
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Loads the user's theme selections from `user_theme_settings` and keeps them
 * live: a save made anywhere in the app repaints every mounted table at once.
 *
 * ───────────────────────────────────────────────────────────────────────────────
 * AUDIT 2026-08-25 — three defects, all of which read to a player as "my theme
 * did not save". Production held 2 rows across 1,025 users when this was found.
 * ───────────────────────────────────────────────────────────────────────────────
 *
 * 1. THE ROW WAS WRITTEN INTO A BUCKET THIS READER NEVER LOOKED IN.
 *    `user_theme_settings` is keyed UNIQUE(user_id, game_type), and this hook
 *    only ever asked for the CANONICAL bucket ('ALL' | 'NLH' | '6+' | 'PLO' |
 *    'PINEAPPLE' | 'MTT' | 'SNG'). But production carries a row keyed
 *    `game_type = 'plo4'` — a RAW variant string, saved by a writer that passed
 *    the variant straight through. Canonicalising 'plo4' gives 'PLO', so the
 *    lookup missed, fell through to the 'ALL' row, and the player's PLO choice
 *    was invisible forever while sitting safely in the table.
 *
 *    Fixed by reading the user's rows ONCE and resolving in-memory:
 *      exact canonical match  >  a row that CANONICALISES to the same bucket
 *                             >  the 'ALL' row.
 *    One round trip instead of two, and every raw-variant row already in the
 *    database starts working without a migration. `canonicalGameType` is
 *    exported so the WRITE side can be keyed the same way at source.
 *
 * 2. THE LIVE LISTENER WAS NEVER ATTACHED AT A TOURNAMENT.
 *    The `UI_THEME_CHANGED` subscription lived below `if (isTournament &&
 *    !tournamentType) return;`. That early return exists for a good reason (see
 *    the note on the load effect), but it also skipped the subscribe — so at
 *    any tournament table whose format had not resolved yet, a theme saved
 *    mid-session did not apply until a remount. The subscription is now its own
 *    effect and always attaches.
 *
 * 3. A FAILED QUERY RENDERED AS A CONFIDENT DEFAULT.
 *    supabase-js RETURNS errors, it does not throw. The old code checked
 *    `!error && data`, then silently proceeded to the fallback and finally to
 *    DEFAULT_THEME with `loading: false` and no signal at all. "We could not
 *    reach the database" and "you have never picked a theme" produced the exact
 *    same screen. `error` is now returned so callers can tell them apart.
 */

import { useState, useEffect, useMemo } from 'react';
import { supabase } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';

export interface UserThemeSelection {
  theme_id: string;
  table_id: string;
  button_id: string;
  background_id: string;
  cards_id: string;
}

export const THEME_FIELDS = [
  'theme_id',
  'table_id',
  'button_id',
  'background_id',
  'cards_id',
] as const;

const DEFAULT_THEME: UserThemeSelection = {
  theme_id: 'default-dark',
  // Dan 2026-08-17: default table skin is the Neon City composite ('dark-felt'
  // still resolves to it via the TABLE_SKINS legacy alias in TablePage).
  table_id: 'neon_city',
  button_id: 'classic-white',
  background_id: 'midnight',
  cards_id: 'classic_red',
};

/** The only values `user_theme_settings.game_type` may be keyed on. */
export const CANONICAL_GAME_TYPES = ['ALL', 'NLH', '6+', 'PLO', 'PINEAPPLE', 'MTT', 'SNG'] as const;

export type CanonicalGameType = (typeof CANONICAL_GAME_TYPES)[number];

/**
 * Maps a game variant string to a theme game type. Categories match the
 * platform's approved variants only — FIX 116 removed FLH / FLO / MIXED, so
 * those branches are gone (they could never match a selectable game type).
 * Approved: ALL | NLH | 6+ (short deck) | PLO | PINEAPPLE | MTT | SNG.
 */
export function getThemeGameType(
  gameVariant?: string,
  isTournament?: boolean,
  tournamentType?: string
): CanonicalGameType {
  if (isTournament) {
    if (tournamentType === 'sng' || tournamentType === 'spin') return 'SNG';
    return 'MTT';
  }
  const v = (gameVariant || '').toLowerCase();
  if (v.includes('nlh') || v === 'no_limit_holdem') return 'NLH';
  if (v.includes('short') || v.includes('6+')) return '6+';
  if (v.includes('pineapple')) return 'PINEAPPLE';
  if (v.includes('plo')) return 'PLO';
  return 'ALL';
}

/**
 * The bucket a stored `game_type` BELONGS to.
 *
 * A value already canonical is returned untouched — importantly '6+', which
 * getThemeGameType would otherwise read as a variant string and, since it
 * contains '6+', happens to answer '6+' anyway; the explicit check means that
 * is by decision rather than by luck. Anything else (a raw variant such as
 * 'plo4', 'nlh6', 'shortdeck') is canonicalised.
 *
 * Exported so the WRITE side can key rows with the same function this reader
 * uses. A writer and a reader that disagree about the key is defect 1 above.
 */
export function canonicalGameType(stored: string | null | undefined): CanonicalGameType {
  const raw = (stored || '').trim();
  if (!raw) return 'ALL';
  const upper = raw.toUpperCase();
  if ((CANONICAL_GAME_TYPES as readonly string[]).includes(upper)) {
    return upper as CanonicalGameType;
  }
  return getThemeGameType(raw);
}

/**
 * The bucket this table's theme should be read from, or NULL when it is not
 * knowable yet.
 *
 * A tournament whose FORMAT has not resolved must not resolve a theme.
 * getThemeGameType answers 'MTT' for anything it cannot identify, so resolving
 * here would paint the player's MTT felt at a Spin and then swap it under them
 * a moment later when the format arrives. Waiting costs a few hundred
 * milliseconds of the default theme, which is what the first frames show
 * anyway; guessing costs a visible change of table mid-sit.
 *
 * This used to be an inline `if (isTournament && !tournamentType) return;` in
 * the load effect, and two test files pinned it by grepping for that exact
 * line. A guard worth keeping is worth asserting as BEHAVIOUR, so it is a
 * function now and those tests call it.
 */
export function resolveThemeBucket(
  gameVariant?: string,
  isTournament?: boolean,
  tournamentType?: string
): CanonicalGameType | null {
  if (isTournament && !tournamentType) return null;
  return getThemeGameType(gameVariant, isTournament, tournamentType);
}

type ThemeRow = Partial<UserThemeSelection> & { game_type?: string | null };

/** Fill every field, so a row with a NULL column cannot blank the felt. */
function toSelection(row: ThemeRow): UserThemeSelection {
  return {
    theme_id: row.theme_id || DEFAULT_THEME.theme_id,
    table_id: row.table_id || DEFAULT_THEME.table_id,
    button_id: row.button_id || DEFAULT_THEME.button_id,
    background_id: row.background_id || DEFAULT_THEME.background_id,
    cards_id: row.cards_id || DEFAULT_THEME.cards_id,
  };
}

/**
 * exact bucket  >  a row that canonicalises INTO the bucket  >  the 'ALL' row.
 *
 * Exported for the test that pins the 'plo4' recovery, and because the same
 * precedence has to hold anywhere else this table is read.
 */
export function pickThemeRow(rows: ThemeRow[], gameType: CanonicalGameType): ThemeRow | null {
  if (!rows.length) return null;
  const exact = rows.find((r) => (r.game_type || '') === gameType);
  if (exact) return exact;
  // The alias step is deliberately NOT applied to 'ALL'. canonicalGameType
  // answers 'ALL' for anything it does not recognise, so allowing it here
  // would let a row keyed on junk ('', 'not_a_variant', a typo) become the
  // player's global default — the everywhere-bucket must be claimed by a
  // literal 'ALL' row and nothing else.
  if (gameType !== 'ALL') {
    const canonical = rows.find(
      (r) => (r.game_type || '') !== 'ALL' && canonicalGameType(r.game_type) === gameType
    );
    if (canonical) return canonical;
  }
  return rows.find((r) => (r.game_type || '') === 'ALL') ?? null;
}

export function useUserThemeSettings(
  userId: string | null | undefined,
  gameVariant?: string,
  isTournament?: boolean,
  tournamentType?: string
) {
  const [theme, setTheme] = useState<UserThemeSelection>({ ...DEFAULT_THEME });
  const [loading, setLoading] = useState(true);
  /**
   * Non-null when the LOAD failed. `theme` still holds the defaults so the felt
   * paints, but a caller must never present those as "the player's choice" —
   * see defect 3 in the header.
   */
  const [error, setError] = useState<string | null>(null);

  /**
   * null while a tournament's format is unresolved: the bucket is not yet
   * knowable, and guessing is what the load effect refuses to do.
   */
  const gameType = useMemo<CanonicalGameType | null>(
    () => resolveThemeBucket(gameVariant, isTournament, tournamentType),
    [gameVariant, isTournament, tournamentType]
  );

  useEffect(() => {
    if (!userId) {
      setLoading(false);
      return;
    }

    // Null bucket: a tournament whose format has not arrived. Wait rather than
    // guess — see resolveThemeBucket for why.
    if (!gameType) return;

    let mounted = true;

    const load = async () => {
      try {
        // ONE query for the user's rows — the table is UNIQUE(user_id,
        // game_type) over seven buckets, so this is a handful of rows at most,
        // and resolving in memory is both cheaper than the old two round trips
        // and the only way to see a row stored under a raw variant key.
        const { data, error: queryError } = await supabase
          .from('user_theme_settings')
          .select('game_type, theme_id, table_id, button_id, background_id, cards_id')
          .eq('user_id', userId);

        if (!mounted) return;

        if (queryError) {
          // A failed read is NOT "no theme saved". Say so and keep the
          // defaults on screen rather than reporting them as a selection.
          setError(queryError.message || 'Could not load theme settings');
          setLoading(false);
          return;
        }

        setError(null);
        const row = pickThemeRow((data as ThemeRow[]) || [], gameType);
        if (row) setTheme(toSelection(row));
      } catch (err) {
        if (!mounted) return;
        console.warn('[useUserThemeSettings] Failed:', err);
        setError(err instanceof Error ? err.message : 'Could not load theme settings');
      }
      if (mounted) setLoading(false);
    };

    load();

    return () => {
      mounted = false;
    };
  }, [userId, gameType]);

  /**
   * Dan 2026-08-19: apply theme changes LIVE. The modal broadcasts the
   * selection the moment it saves; any table currently mounted (including ones
   * the player is only watching) repaints instantly instead of waiting for a
   * remount. A change saved against "ALL" applies to every game type; a
   * per-game-type change only applies to that type.
   *
   * AUDIT 2026-08-25: this used to live inside the load effect, BELOW the
   * unresolved-tournament early return — so at a tournament whose format had
   * not arrived yet, nothing was ever subscribed and live application silently
   * did not happen. Its own effect now, so it always attaches.
   */
  useEffect(() => {
    let mounted = true;

    const off = masterBus.subscribe('UI_THEME_CHANGED', (event) => {
      // AUDIT 2026-08-19 (P0): masterBus hands subscribers the EVENT WRAPPER
      // ({ type, payload, timestamp }), not the raw payload. Reading .key/.value
      // off the wrapper always yielded undefined, so this listener returned early
      // on every emit and live theme application silently never worked.
      const body = (event as { payload?: unknown })?.payload ?? event;
      const savedFor = (body as { key?: string })?.key;
      const selection = (body as { value?: Partial<UserThemeSelection> })?.value;
      if (!mounted || !selection) return;
      // AUDIT 2026-08-19: UI_THEME_CHANGED is a SHARED event — useSettingsStore
      // emits it as { key: 'theme', value: '<theme name string>' }. The gameType
      // guard below already rejects that, but spreading a string into the
      // selection object would produce garbage keys, so validate the shape
      // explicitly rather than relying on the guard alone.
      if (typeof selection !== 'object' || Array.isArray(selection)) return;
      if (!THEME_FIELDS.some((f) => f in selection)) return;

      // A change saved against "ALL" applies everywhere.
      const savedBucket = savedFor ? canonicalGameType(savedFor) : null;
      if (savedFor && savedFor !== 'ALL' && savedBucket !== 'ALL') {
        // While a tournament's format is unresolved this table has no bucket of
        // its own, so only an "ALL" save may touch it — the same refusal to
        // guess that the load effect makes.
        if (!gameType || savedBucket !== gameType) return;
      }

      // Only the five theme fields, never whatever else rode along on the bus.
      const clean: Partial<UserThemeSelection> = {};
      for (const field of THEME_FIELDS) {
        const value = (selection as Record<string, unknown>)[field];
        if (typeof value === 'string' && value) clean[field] = value;
      }
      if (!Object.keys(clean).length) return;

      setTheme((prev) => ({ ...prev, ...clean }));
    });

    return () => {
      mounted = false;
      try {
        off?.();
      } catch {
        /* listener already detached */
      }
    };
  }, [gameType]);

  return { theme, loading, error };
}
