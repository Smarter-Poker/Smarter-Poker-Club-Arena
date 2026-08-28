import { useState, useEffect, useCallback, useRef } from 'react';
import { masterBus } from '../core/MasterBus';
import { useUserStore } from '../stores/useUserStore';

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * useTableSettings Hook
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Manages user preferences for poker table UI/UX including:
 * - Sound and haptic feedback control
 * - Animation speed adjustments
 * - Table appearance (theme, deck style)
 * - Display options (HUD, pot odds)
 * - Gameplay preferences (auto-muck, confirm all-in, etc.)
 *
 * All settings are persisted to localStorage and automatically applied to the DOM.
 */

export interface TableUserSettings {
  isSoundEnabled: boolean;
  soundVolume: number; // 0-100
  isHapticEnabled: boolean;
  animationSpeed: number; // 0.5, 1, 1.5, 2
  theme: string; // 'green', 'blue', 'red', 'purple', etc.
  fourColorDeck: boolean;
  showHUD: boolean;
  showPotOdds: boolean;
  showBetSizePresets: boolean;
  confirmAllIn: boolean;
  autoMuck: boolean;
  /**
   * SHOWDOWN AUDIT 2026-08-25 (Dan: "ENABLE AUTO MUCK BY DEFAULT, AND MAKE
   * USERS TURN IT OFF MANUALLY"): true only once the user has personally
   * toggled autoMuck. The old default was FALSE and this hook persists the
   * WHOLE settings object on every write, so any player who ever changed any
   * table setting has autoMuck:false sitting in localStorage without ever
   * choosing it. Without this marker, flipping the default to true did
   * nothing for exactly those players — worse, it would auto-SHOW their
   * losing hands. The loader below forces autoMuck true unless this marker
   * proves the false was a deliberate choice made AFTER the toggle shipped.
   */
  autoMuckExplicit: boolean;
  autoMuckWinners: boolean;
  autoPostBlinds: boolean;
  cardBack: string; // Card back design ID
  showStackInBB: boolean;
  autoRebuy: boolean; // Auto-rebuy when stack drops below threshold
  /**
   * Dan 2026-08-28: "add a toggle in the table settings, and in the Club
   * Arena settings, to turn the ticker on or off." The scrolling
   * tournament/announcement marquee (TournamentStartingTicker's .mtt-ticker)
   * reads this; default ON. The BBJ banner is a different element and is NOT
   * governed by this.
   */
  showTicker: boolean;
}

const DEFAULT_SETTINGS: TableUserSettings = {
  isSoundEnabled: true,
  soundVolume: 70,
  isHapticEnabled: true,
  animationSpeed: 1,
  theme: 'black',
  fourColorDeck: false,
  showHUD: true,
  showPotOdds: false,
  showBetSizePresets: true,
  confirmAllIn: true,
  // SHOWDOWN follow-up 2026-08-25 (Dan spec section 37): AUTO-MUCK LOSING
  // HANDS, on by default — the engine mucks a beaten hand automatically at
  // showdown. Switching it OFF means "always table my hand": the client
  // answers the engine's muck ruling with the existing voluntary-show call
  // (POST /showhand), so the hand turns face up with NO prompt — prompts
  // remain forbidden (Dan 2026-08-18, binding). The setting can never muck
  // a winner (the engine auto-tables winners regardless) and can never hide
  // an all-in showdown (every live all-in hand is force-exposed).
  autoMuck: true,
  autoMuckExplicit: false,
  autoMuckWinners: false,
  autoPostBlinds: true,
  // Dan 2026-08-18: was 'black', which has no `.card-back--black` rule in
  // CardImage.css - so the DEFAULT card back rendered as a blank rectangle for
  // every player who never opened the picker. 'classic_blue' is a real design
  // and matches SeatSlot's own fallback. CardBack normalises unknown ids now
  // too, so a stale 'black' already sitting in localStorage also recovers.
  cardBack: 'classic_blue',
  showStackInBB: false,
  autoRebuy: false,
  showTicker: true,
};

import { STORAGE_KEYS } from '../lib/storage';
const STORAGE_KEY = STORAGE_KEYS.TABLE_SETTINGS;
const CSS_VAR_ANIMATION_SPEED = '--animation-speed';
/**
 * Dan 2026-08-28 (settings must apply live): `data-theme` was owned by TWO
 * unrelated systems at once — this hook wrote the table COLOR theme
 * ('black'/'green'/'blue'/...) into it, while the Theme Studio's Interface
 * toggle, Shell.tsx, useSettingsStore and MasterBus all write 'light'/'dark'
 * into the same attribute. Whichever wrote last won, so picking Light mode
 * held only until this hook's effect re-ran (every table mount) and stamped
 * it back to a color name — the "doesn't stick until reload" symptom.
 *
 * The color theme now rides its own attribute. design-tokens.css matches
 * BOTH `[data-theme=…]` and `[data-color-theme=…]` for every palette, so no
 * skin changes; `data-theme` itself now belongs exclusively to the
 * light/dark interface mode.
 */
const DOM_ATTR_THEME = 'data-color-theme';

export function useTableSettings() {
  // Load from localStorage on mount
  const [settings, setSettings] = useState<TableUserSettings>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const merged = {
          ...DEFAULT_SETTINGS,
          ...JSON.parse(saved),
        };
        // SHOWDOWN AUDIT 2026-08-25 — hostile-state migration. autoMuck's
        // default used to be false and rode along in every persisted write,
        // so a stored false proves nothing about what the player wants. Only
        // a false written by the user's own toggle (autoMuckExplicit) is
        // honoured; every other stored value is lifted to the new default.
        // Auto-muck is ON unless the user personally turned it off.
        if (merged.autoMuckExplicit !== true) {
          merged.autoMuck = true;
        }
        return merged;
      }
      return DEFAULT_SETTINGS;
    } catch (error) {
      console.warn('Failed to load table settings from localStorage:', error);
      return DEFAULT_SETTINGS;
    }
  });

  // Persist settings to localStorage whenever they change
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch (error) {
      console.warn('Failed to save table settings to localStorage:', error);
    }
  }, [settings]);

  // Apply theme to DOM (data-theme attribute on root element)
  useEffect(() => {
    document.documentElement.setAttribute(DOM_ATTR_THEME, settings.theme);
  }, [settings.theme]);

  // Apply animation speed to DOM (CSS custom property)
  useEffect(() => {
    document.documentElement.style.setProperty(
      CSS_VAR_ANIMATION_SPEED,
      String(settings.animationSpeed)
    );
  }, [settings.animationSpeed]);

  // Sync haptic setting to HapticService's localStorage key
  useEffect(() => {
    try {
      localStorage.setItem('vibrationsEnabled', String(settings.isHapticEnabled));
    } catch {
      // localStorage unavailable
    }
  }, [settings.isHapticEnabled]);

  /**
   * WHO EMITTED THIS — an identity, not a latch.
   *
   * Dan 2026-08-26 (settings audit). This used to be `localOriginRef =
   * useRef(false)`: set true immediately before `masterBus.emit`, and cleared
   * by this instance's own subscriber when the echo came back. That is a
   * one-shot latch which depends on the echo ALWAYS arriving, and it does not:
   * MasterBus drops a duplicate `{type, payload}` fingerprint inside 500ms
   * (SETTINGS_CHANGED is not in DEDUP_BYPASS). Set a setting to the value it
   * already has, or tap Reset twice, and the emit is suppressed — the echo
   * never comes, the flag stays TRUE, and the very next genuine change from
   * ANOTHER component or tab is silently swallowed. The symptom is the one
   * being fixed across this whole pass: a setting that stops updating live,
   * intermittently, with nothing in the console.
   *
   * A per-instance id has no state to get stuck in. Every emit says who sent
   * it; every receiver ignores only its own. A suppressed emit now costs
   * nothing at all.
   */
  const originIdRef = useRef<string>(`ts-${Math.random().toString(36).slice(2)}`);
  useEffect(() => {
    const unsub = masterBus.subscribe('SETTINGS_CHANGED', (event) => {
      // Skip only OUR OWN echo (prevent redundant setSettings).
      if (event.payload?.origin === originIdRef.current) return;
      const activeUserId = useUserStore.getState().user?.id;
      if (event.payload.userId && event.payload.userId !== activeUserId) return;
      const { setting, value } = event.payload;
      if (setting && setting in DEFAULT_SETTINGS) {
        setSettings((prev) => ({
          ...prev,
          [setting]: value,
          // SHOWDOWN AUDIT 2026-08-25: cross-tab autoMuck toggles are just as
          // deliberate as local ones — mark them explicit too, or the other
          // tab's loader would lift the user's own choice back to true.
          ...(setting === 'autoMuck' ? { autoMuckExplicit: true } : {}),
        }));
      }
    });
    return unsub;
  }, []);

  // Update a single setting by key
  const updateSetting = useCallback(
    <K extends keyof TableUserSettings>(key: K, value: TableUserSettings[K]) => {
      setSettings((prev) => ({
        ...prev,
        [key]: value,
        // SHOWDOWN AUDIT 2026-08-25: a personal autoMuck toggle is the ONLY
        // thing that makes a stored false authoritative — see the loader.
        ...(key === 'autoMuck' ? { autoMuckExplicit: true } : {}),
      }));
      // Broadcast for cross-tab / cross-component sync
      masterBus.emit('SETTINGS_CHANGED', {
        setting: key,
        value: value as string | number | boolean,
        origin: originIdRef.current,
      });
    },
    []
  );

  // Reset all settings to defaults
  const resetSettings = useCallback(() => {
    setSettings(DEFAULT_SETTINGS);
    // Broadcast each default for cross-tab sync
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      masterBus.emit('SETTINGS_CHANGED', {
        setting: key,
        value: value as string | number | boolean,
        origin: originIdRef.current,
      });
    }
  }, []);

  // Bulk update multiple settings at once
  const updateSettings = useCallback((updates: Partial<TableUserSettings>) => {
    setSettings((prev) => ({
      ...prev,
      ...updates,
      // SHOWDOWN AUDIT 2026-08-25: same rule as updateSetting — an autoMuck
      // value arriving through the bulk path is a user action too.
      ...('autoMuck' in updates ? { autoMuckExplicit: true } : {}),
    }));
    // Broadcast each change for cross-tab sync
    for (const [key, value] of Object.entries(updates)) {
      masterBus.emit('SETTINGS_CHANGED', {
        setting: key,
        value: value as string | number | boolean,
        origin: originIdRef.current,
      });
    }
  }, []);

  return {
    settings,
    updateSetting,
    updateSettings,
    resetSettings,
  };
}
