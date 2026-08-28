import { useCallback, useSyncExternalStore } from 'react';
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

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  ONE STORE, NOT ONE PER COMPONENT
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-28, binding: "WHEN YOU DO TURN THINGS ON OR OFF IN THE TABLE
 * SETTINGS, THEY NEED TO SAVE GLOBALLY IN REAL TIME ON ALL TABLES, AND ALL
 * PAGES. AND NEVER REGRESS OR AUTO CHANGE BACK UNLESS THE USER CHANGES THEM
 * MANUALLY."
 *
 * THE MECHANISM BEHIND "AUTO CHANGE BACK", and it was structural rather than a
 * bug in any one setting:
 *
 * This hook used to hold the settings in a per-instance `useState`, and persist
 * the WHOLE object to one localStorage key on every change. It is called by
 * TablePage, SettingsPage and TournamentStartingTicker — and MultiTablePage
 * keeps up to SIX TablePages mounted at once. So there were commonly eight
 * independent copies of the settings, each one writing its own complete blob
 * over the same key.
 *
 * Live updates between them relied entirely on the `SETTINGS_CHANGED` bus
 * message arriving everywhere. Miss one — and MasterBus drops a duplicate
 * `{type, payload}` fingerprint inside 500ms, which happens whenever a value is
 * set to what it already is — and that instance is now stale. It does not fail
 * loudly. It waits. The next time ANY setting changes in that instance, its
 * stale full object is written over the key, and every setting the user changed
 * elsewhere in the meantime silently reverts. That is the reported symptom
 * exactly: settings that change back on their own, with no error.
 *
 * A single module-level store removes the failure by construction. There is one
 * object, so there is nothing to diverge; every consumer reads the same value
 * through `useSyncExternalStore`, so a change is visible on every table and
 * every page in the same tick, whether or not the bus message is delivered. The
 * bus emit is kept for OTHER browser tabs, where it is still the only channel.
 *
 * LAZY, not initialised at import: the store reads localStorage on first use so
 * a test (or any caller) that stubs storage before rendering still gets a
 * truthful load. `__resetTableSettingsStoreForTest` is the seam for that.
 */

/** The one copy. `null` until first read — see the note above on laziness. */
let sharedSettings: TableUserSettings | null = null;
const listeners = new Set<() => void>();

function loadFromStorage(): TableUserSettings {
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
}

/**
 * Everything a settings value has to reach OUTSIDE React, done once per change
 * rather than once per mounted component.
 *
 * These were three `useEffect`s keyed on individual fields. With eight mounted
 * copies that was eight writers racing over the same DOM attribute and the same
 * localStorage mirror on every render pass — the same collision class as the
 * `data-theme` ownership fight documented above.
 */
function applySideEffects(next: TableUserSettings): void {
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute(DOM_ATTR_THEME, next.theme);
    document.documentElement.style.setProperty(
      CSS_VAR_ANIMATION_SPEED,
      String(next.animationSpeed)
    );
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    // HapticService reads its own key.
    localStorage.setItem('vibrationsEnabled', String(next.isHapticEnabled));
  } catch (error) {
    console.warn('Failed to save table settings to localStorage:', error);
  }
}

function getSnapshot(): TableUserSettings {
  if (sharedSettings === null) {
    sharedSettings = loadFromStorage();
    applySideEffects(sharedSettings);
  }
  return sharedSettings;
}

/** Replace the one copy, persist it, apply it, and wake every consumer. */
function commit(update: (prev: TableUserSettings) => TableUserSettings): void {
  const next = update(getSnapshot());
  if (next === sharedSettings) return;
  sharedSettings = next;
  applySideEffects(next);
  for (const listener of listeners) listener();
}

function subscribeToStore(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * WHO EMITTED THIS — an identity, not a latch. Module-level now, because the
 * store is: one store, one origin. Shaped as a `.current` box deliberately, so
 * the emits below keep reading `origin: originIdRef.current` — the property
 * `tests/unit/settingsEchoOrigin.test.ts` pins, for the reasons its header
 * gives at length.
 */
const originIdRef = { current: `ts-${Math.random().toString(36).slice(2)}` };

/**
 * ONE bus subscription for the whole app, attached on first use.
 *
 * Previously every hook instance subscribed, so a cross-tab change woke eight
 * handlers that each mutated their own copy. Now it wakes the single store.
 */
let busAttached = false;
function attachBusOnce(): void {
  if (busAttached) return;
  busAttached = true;
  masterBus.subscribe('SETTINGS_CHANGED', (event) => {
    // Skip only OUR OWN echo (prevent a redundant commit).
    if (event.payload?.origin === originIdRef.current) return;
    const activeUserId = useUserStore.getState().user?.id;
    if (event.payload.userId && event.payload.userId !== activeUserId) return;
    const { setting, value } = event.payload;
    if (setting && setting in DEFAULT_SETTINGS) {
      commit((prev) => ({
        ...prev,
        [setting]: value,
        // SHOWDOWN AUDIT 2026-08-25: cross-tab autoMuck toggles are just as
        // deliberate as local ones — mark them explicit too, or the other
        // tab's loader would lift the user's own choice back to true.
        ...(setting === 'autoMuck' ? { autoMuckExplicit: true } : {}),
      }));
    }
  });
}

/**
 * TEST SEAM. The store is a module singleton, so a suite that wants to assert
 * load-time behaviour has to be able to forget it — the same way it already
 * clears localStorage between cases.
 */
export function __resetTableSettingsStoreForTest(): void {
  sharedSettings = null;
  listeners.clear();
}

export function useTableSettings() {
  attachBusOnce();
  const settings = useSyncExternalStore(subscribeToStore, getSnapshot, getSnapshot);

  // Update a single setting by key
  const updateSetting = useCallback(
    <K extends keyof TableUserSettings>(key: K, value: TableUserSettings[K]) => {
      commit((prev) => ({
        ...prev,
        [key]: value,
        // SHOWDOWN AUDIT 2026-08-25: a personal autoMuck toggle is the ONLY
        // thing that makes a stored false authoritative — see the loader.
        ...(key === 'autoMuck' ? { autoMuckExplicit: true } : {}),
      }));
      // Broadcast for cross-TAB sync. Within this tab the shared store above
      // has already updated every consumer, so a dropped message costs nothing.
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
    commit(() => DEFAULT_SETTINGS);
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
    commit((prev) => ({
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
