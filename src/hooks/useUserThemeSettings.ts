/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * useUserThemeSettings — Bible V8 §11.2 Theme Persistence Hook
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Loads the user's theme selections from `user_theme_settings` table.
 * Falls back to "ALL" game type if no per-game-type override exists.
 * Returns the active theme_id and background_id for the current game type.
 */

import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';

export interface UserThemeSelection {
  theme_id: string;
  table_id: string;
  button_id: string;
  background_id: string;
  cards_id: string;
}

const DEFAULT_THEME: UserThemeSelection = {
  theme_id: 'default-dark',
  // Dan 2026-08-17: default table skin is the Neon City composite ('dark-felt'
  // still resolves to it via the TABLE_SKINS legacy alias in TablePage).
  table_id: 'neon_city',
  button_id: 'classic-white',
  background_id: 'midnight',
  cards_id: 'classic_red',
};

/**
 * Maps a game variant string to a theme game type. Categories match the
 * platform's approved variants only — FIX 116 removed FLH / FLO / MIXED, so
 * those branches are gone (they could never match a selectable game type).
 * Approved: ALL | NLH | 6+ (short deck) | PLO | PINEAPPLE | MTT | SNG.
 */
function getThemeGameType(
  gameVariant?: string,
  isTournament?: boolean,
  tournamentType?: string
): string {
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

export function useUserThemeSettings(
  userId: string | null | undefined,
  gameVariant?: string,
  isTournament?: boolean,
  tournamentType?: string
) {
  const [theme, setTheme] = useState<UserThemeSelection>({ ...DEFAULT_THEME });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!userId) {
      setLoading(false);
      return;
    }

    /**
     * A tournament whose FORMAT has not resolved yet must not resolve a theme.
     *
     * getThemeGameType answers 'MTT' for anything it cannot identify, so
     * loading here would paint the player's MTT felt at a Spin and then swap it
     * under them a moment later when the format arrives. Waiting costs a few
     * hundred milliseconds of the default theme, which is what the first frames
     * show anyway; guessing costs a visible change of table mid-sit.
     */
    if (isTournament && !tournamentType) return;

    let mounted = true;
    const gameType = getThemeGameType(gameVariant, isTournament, tournamentType);

    const load = async () => {
      try {
        // Try per-game-type first
        const { data, error } = await supabase
          .from('user_theme_settings')
          .select('theme_id, table_id, button_id, background_id, cards_id')
          .eq('user_id', userId)
          .eq('game_type', gameType)
          .maybeSingle();

        if (!error && data && mounted) {
          setTheme({
            theme_id: data.theme_id || DEFAULT_THEME.theme_id,
            table_id: data.table_id || DEFAULT_THEME.table_id,
            button_id: data.button_id || DEFAULT_THEME.button_id,
            background_id: data.background_id || DEFAULT_THEME.background_id,
            cards_id: data.cards_id || DEFAULT_THEME.cards_id,
          });
          if (mounted) setLoading(false);
          return;
        }

        // Fallback to ALL game type
        if (gameType !== 'ALL') {
          const { data: fallback } = await supabase
            .from('user_theme_settings')
            .select('theme_id, table_id, button_id, background_id, cards_id')
            .eq('user_id', userId)
            .eq('game_type', 'ALL')
            .maybeSingle();

          if (fallback && mounted) {
            setTheme({
              theme_id: fallback.theme_id || DEFAULT_THEME.theme_id,
              table_id: fallback.table_id || DEFAULT_THEME.table_id,
              button_id: fallback.button_id || DEFAULT_THEME.button_id,
              background_id: fallback.background_id || DEFAULT_THEME.background_id,
              cards_id: fallback.cards_id || DEFAULT_THEME.cards_id,
            });
          }
        }
      } catch (err) {
        console.warn('[useUserThemeSettings] Failed:', err);
      }
      if (mounted) setLoading(false);
    };

    load();

    /**
     * Dan 2026-08-19: apply theme changes LIVE. The modal now broadcasts the
     * selection the moment it saves; any table currently mounted (including
     * ones the player is only watching) repaints instantly instead of waiting
     * for a remount. A change saved against "ALL" applies to every game type;
     * a per-game-type change only applies to that type.
     */
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
      const THEME_FIELDS = ['theme_id', 'table_id', 'button_id', 'background_id', 'cards_id'];
      if (!THEME_FIELDS.some((f) => f in selection)) return;
      // A change saved against "ALL" applies everywhere; a per-game-type
      // change only applies to that type.
      if (
        savedFor &&
        savedFor !== 'ALL' &&
        savedFor !== gameType &&
        getThemeGameType(savedFor) !== gameType
      ) {
        return;
      }
      setTheme((prev) => ({ ...prev, ...selection }));
    });

    return () => {
      mounted = false;
      try {
        off?.();
      } catch {
        /* listener already detached */
      }
    };
  }, [userId, gameVariant, isTournament, tournamentType]);

  return { theme, loading };
}
