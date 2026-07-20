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

export interface UserThemeSelection {
  theme_id: string;
  table_id: string;
  button_id: string;
  background_id: string;
  cards_id: string;
}

const DEFAULT_THEME: UserThemeSelection = {
  theme_id: 'default-dark',
  table_id: 'dark-felt',
  button_id: 'classic-white',
  background_id: 'diamond-pattern',
  cards_id: 'standard-red',
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
    return () => {
      mounted = false;
    };
  }, [userId, gameVariant, isTournament, tournamentType]);

  return { theme, loading };
}
