/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * useUserTableSettings — Bible V8 §11.1 User Table Settings Hook
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Central hook for reading/writing user table preferences.
 * Data flow:
 *   1. On mount → read from Supabase `user_table_settings` (keyed by user_id)
 *   2. Fallback → localStorage cache if Supabase fails
 *   3. On toggle → optimistic update + upsert to Supabase + broadcast via MasterBus
 *   4. Cross-component sync via MasterBus SETTINGS_CHANGED events
 *
 * Used in TWO locations (Bible V8 §11.1):
 *   - Table gear icon → TableSettingsPanel
 *   - Hamburger menu → Settings section
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';
import { STORAGE_KEYS } from '../lib/storage';
import { reportError } from '../utils/errorReporter';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES — matches Bible V8 §11.1.1 exactly
// ═══════════════════════════════════════════════════════════════════════════════

export interface UserTableSettings {
  highlight_active_players: boolean;
  show_avatars: boolean;
  show_badges: boolean;
  cards_pre_sort: boolean;
  gestures_enabled: boolean;
  card_slide: boolean;
  show_stack_in_bb: boolean;
  auto_time_bank: boolean;
  enhanced_view: boolean;
  voice_message: boolean;
  text_message: boolean;
  emoji_enabled: boolean;
  /** FIX 173: Bible V8 §10.3 — Skip animations option for speed players */
  skip_animations: boolean;
  /** Use club alias instead of smarter.poker display name */
  use_alias: boolean;
  /** Custom club alias text — shown at table when use_alias is true */
  table_alias: string;
}

export const DEFAULT_USER_TABLE_SETTINGS: UserTableSettings = {
  highlight_active_players: true,
  show_avatars: true,
  show_badges: false,
  cards_pre_sort: true,
  gestures_enabled: false,
  card_slide: true,
  show_stack_in_bb: false,
  auto_time_bank: false,
  enhanced_view: true,
  voice_message: true,
  text_message: true,
  emoji_enabled: true,
  skip_animations: false,
  use_alias: false,
  table_alias: '',
};

// Metadata for rendering toggles
export interface SettingMeta {
  key: keyof UserTableSettings;
  label: string;
  description: string;
}

// Only list a setting here if flipping it changes what the player sees.
// TABLE_SETTINGS_META drives the toggle list in TableSettingsPanel, so an entry
// with no consumer is a switch that persists to the database and does nothing —
// the player flips it, sees no change, and concludes the table is broken.
//
// Deliberately NOT listed:
//   highlight_active_players — the acting-seat spotlight is unconditional by
//     product decision (2026-08-15: "must always be ON AT ALL TIMES"), so
//     TablePage stopped reading this column. Keeping the switch on screen
//     advertised control that no longer existed.
//   voice_message — there is no voice chat at a poker table in this codebase.
//     Its only consumer muted the TEXT chat, so "Voice Message: off" silently
//     took away text chat instead. List it again when voice actually ships.
//
// Both columns stay in UserTableSettings and in the database: the rows already
// exist, and removing the toggle must not drop a player's stored value.
export const TABLE_SETTINGS_META: SettingMeta[] = [
  {
    key: 'show_avatars',
    label: 'Show Avatars',
    description: 'Display player avatar images at seats',
  },
  {
    key: 'show_badges',
    label: 'Show Badges',
    description: 'Display VIP/achievement badges at seats',
  },
  {
    key: 'cards_pre_sort',
    label: 'Cards Pre-Sort',
    description: 'Auto-sort hole cards by rank (high to low)',
  },
  {
    key: 'gestures_enabled',
    label: 'Gestures',
    description: 'Enable swipe/drag gesture controls for actions',
  },
  {
    key: 'card_slide',
    label: 'Card Slide',
    description: 'Enable card peek/slide reveal animation',
  },
  {
    key: 'show_stack_in_bb',
    label: 'Show Stack in Big Blinds',
    description: 'Display chip stacks as BB count instead of chip value',
  },
  {
    key: 'auto_time_bank',
    label: 'Auto Time Bank',
    description: 'Auto-activate time bank when primary timer expires',
  },
  {
    key: 'enhanced_view',
    label: 'Enhanced View',
    description: 'Enable enhanced visual effects and animations',
  },
  { key: 'text_message', label: 'Text Message', description: 'Enable text chat at table' },
  { key: 'emoji_enabled', label: 'Emoji', description: 'Enable emoji reactions/throwables' },
  // Dan 2026-08-18: "remove the skip animations toggle, animations are not
  // optional." This definition list is what renders the switches, so dropping
  // the entry removes the control everywhere it appeared. The column and the
  // interface field are deliberately kept - no migration, nothing reading the
  // type breaks - but nothing writes it any more, and TablePage no longer
  // applies it: it now actively clears the duration overrides so a stale
  // cached `true` cannot leave a table permanently un-animated.
  //
  // Accessibility is unaffected; prefers-reduced-motion is handled in CSS.
  {
    key: 'use_alias',
    label: 'Use Club Alias',
    description: 'Display your club alias instead of your smarter.poker name at the table',
  },
];

const LOCAL_CACHE_KEY = 'user_table_settings_cache';

// ═══════════════════════════════════════════════════════════════════════════════
// HOOK
// ═══════════════════════════════════════════════════════════════════════════════

export function useUserTableSettings(userId: string | null | undefined) {
  const [settings, setSettings] = useState<UserTableSettings>(() => {
    // Instant load from localStorage cache
    try {
      const cached = localStorage.getItem(LOCAL_CACHE_KEY);
      if (cached) return { ...DEFAULT_USER_TABLE_SETTINGS, ...JSON.parse(cached) };
    } catch {
      /* ignore */
    }
    return { ...DEFAULT_USER_TABLE_SETTINGS };
  });
  const [loading, setLoading] = useState(true);
  const localOriginRef = useRef(false);
  // Keep a ref to the latest settings to avoid stale closure in toggleSetting
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  // ── Load from Supabase on mount ──
  useEffect(() => {
    if (!userId) {
      setLoading(false);
      return;
    }

    let mounted = true;
    const load = async () => {
      try {
        const { data, error } = await supabase
          .from('user_table_settings')
          .select('*')
          .eq('user_id', userId)
          .maybeSingle();

        if (error) {
          console.warn('[useUserTableSettings] Load failed, using cache:', error.message);
          setLoading(false);
          return;
        }

        if (data && mounted) {
          const loaded: UserTableSettings = {
            highlight_active_players:
              data.highlight_active_players ?? DEFAULT_USER_TABLE_SETTINGS.highlight_active_players,
            show_avatars: data.show_avatars ?? DEFAULT_USER_TABLE_SETTINGS.show_avatars,
            show_badges: data.show_badges ?? DEFAULT_USER_TABLE_SETTINGS.show_badges,
            cards_pre_sort: data.cards_pre_sort ?? DEFAULT_USER_TABLE_SETTINGS.cards_pre_sort,
            gestures_enabled: data.gestures_enabled ?? DEFAULT_USER_TABLE_SETTINGS.gestures_enabled,
            card_slide: data.card_slide ?? DEFAULT_USER_TABLE_SETTINGS.card_slide,
            show_stack_in_bb: data.show_stack_in_bb ?? DEFAULT_USER_TABLE_SETTINGS.show_stack_in_bb,
            auto_time_bank: data.auto_time_bank ?? DEFAULT_USER_TABLE_SETTINGS.auto_time_bank,
            enhanced_view: data.enhanced_view ?? DEFAULT_USER_TABLE_SETTINGS.enhanced_view,
            voice_message: data.voice_message ?? DEFAULT_USER_TABLE_SETTINGS.voice_message,
            text_message: data.text_message ?? DEFAULT_USER_TABLE_SETTINGS.text_message,
            emoji_enabled: data.emoji_enabled ?? DEFAULT_USER_TABLE_SETTINGS.emoji_enabled,
            skip_animations: data.skip_animations ?? DEFAULT_USER_TABLE_SETTINGS.skip_animations,
            use_alias: data.use_alias ?? DEFAULT_USER_TABLE_SETTINGS.use_alias,
            table_alias: data.table_alias ?? DEFAULT_USER_TABLE_SETTINGS.table_alias,
          };
          setSettings(loaded);
          // Cache locally for instant loads
          try {
            localStorage.setItem(LOCAL_CACHE_KEY, JSON.stringify(loaded));
          } catch {
            /* */
          }
        }
        // If no row exists, defaults are already set — row will be created on first toggle
      } catch (err) {
        console.warn('[useUserTableSettings] Unexpected error:', err);
      }
      if (mounted) setLoading(false);
    };

    load();
    return () => {
      mounted = false;
    };
  }, [userId]);

  // ── Listen for cross-component SETTINGS_CHANGED events ──
  useEffect(() => {
    const unsub = masterBus.subscribe('SETTINGS_CHANGED', (event) => {
      if (localOriginRef.current) {
        localOriginRef.current = false;
        return;
      }
      const { setting, value } = event.payload;
      if (setting && setting in DEFAULT_USER_TABLE_SETTINGS) {
        setSettings((prev) => {
          const updated = { ...prev, [setting]: value };
          try {
            localStorage.setItem(LOCAL_CACHE_KEY, JSON.stringify(updated));
          } catch {
            /* */
          }
          return updated;
        });
      }
    });
    return unsub;
  }, []);

  // ── Toggle a single setting ──
  const toggleSetting = useCallback(
    async (key: keyof UserTableSettings) => {
      if (!userId) return;

      // Read from ref to avoid stale closure on rapid toggles
      const newValue = !settingsRef.current[key];

      // Optimistic update
      setSettings((prev) => {
        const updated = { ...prev, [key]: newValue };
        try {
          localStorage.setItem(LOCAL_CACHE_KEY, JSON.stringify(updated));
        } catch {
          /* */
        }
        return updated;
      });

      // Broadcast for cross-component sync
      localOriginRef.current = true;
      masterBus.emit('SETTINGS_CHANGED', { setting: key, value: newValue });

      // Backward compat: sync show_stack_in_bb to old localStorage key used by HamburgerMenu
      if (key === 'show_stack_in_bb') {
        try {
          localStorage.setItem(STORAGE_KEYS.SHOW_STACK_BB, String(newValue));
        } catch {
          /* */
        }
      }

      // Persist to Supabase
      try {
        const { error } = await supabase.from('user_table_settings').upsert(
          {
            user_id: userId,
            [key]: newValue,
          },
          { onConflict: 'user_id' }
        );

        if (error) {
          reportError(error, 'useUserTableSettings.Save_failed');
          // Rollback on failure
          setSettings((prev) => {
            const reverted = { ...prev, [key]: !newValue };
            try {
              localStorage.setItem(LOCAL_CACHE_KEY, JSON.stringify(reverted));
            } catch {
              /* */
            }
            return reverted;
          });
        }
      } catch (err) {
        reportError(err, 'useUserTableSettings.Unexpected_save_error');
      }
    },
    [userId]
  );

  // ── Set a string setting (for table_alias) ──
  const setAlias = useCallback(
    async (alias: string) => {
      if (!userId) return;

      // Optimistic update
      setSettings((prev) => {
        const updated = { ...prev, table_alias: alias };
        try {
          localStorage.setItem(LOCAL_CACHE_KEY, JSON.stringify(updated));
        } catch {
          /* */
        }
        return updated;
      });

      // Broadcast for cross-component sync
      localOriginRef.current = true;
      masterBus.emit('SETTINGS_CHANGED', { setting: 'table_alias', value: alias });

      // Persist to Supabase
      try {
        const { error } = await supabase.from('user_table_settings').upsert(
          {
            user_id: userId,
            table_alias: alias,
          },
          { onConflict: 'user_id' }
        );

        if (error) {
          reportError(error, 'useUserTableSettings.Alias_save_failed');
        }
      } catch (err) {
        reportError(err, 'useUserTableSettings.Alias_save_error');
      }
    },
    [userId]
  );

  return { settings, loading, toggleSetting, setAlias };
}
