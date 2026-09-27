import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { masterBus } from '../core/MasterBus';
import { STORAGE_KEYS } from '../lib/storage';

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THIS STORE OWNS THE INTERFACE MODE. THAT IS ALL IT OWNS.
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * It used to also hold `soundEnabled`, `fourColorDeck` and `notificationsEnabled`
 * with a toggle for each. Every one of the six was dead: repo-wide, the only
 * members ever read off this store are `theme` and `setTheme`, and
 * `toggleSound` / `toggleFourColorDeck` / `toggleNotifications` had zero call
 * sites.
 *
 * Dead is the smaller half of the problem. `soundEnabled` was a FOURTH persisted
 * copy of "is sound on" (after `ca_sound_enabled`, `club_arena_sounds` and
 * `TableUserSettings.isSoundEnabled` + its column), and `fourColorDeck` a THIRD
 * copy of the deck preference — sitting in localStorage, free to disagree with
 * the real ones forever, and ready to be wired up by the next contributor who
 * finds a plausibly-named toggle and gets a switch that does nothing.
 *
 * Removed 2026-08-29. Sound belongs to `utils/soundGate` and the deck to
 * `useTableSettings`. If this store ever needs to grow again, check those first.
 */
export type InterfaceThemePreference = 'dark' | 'light' | 'auto';

interface SettingsState {
  theme: 'dark' | 'light';
  themePreference: InterfaceThemePreference;
  setTheme: (theme: InterfaceThemePreference, userId?: string) => void;
  receiveTheme: (theme: InterfaceThemePreference, userId?: string) => void;
}

function effectiveTheme(preference: InterfaceThemePreference): 'dark' | 'light' {
  return preference === 'auto'
    ? typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-color-scheme: light)').matches
      ? 'light'
      : 'dark'
    : preference;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => {
      const apply = (preference: InterfaceThemePreference, userId?: string) => {
        const theme = effectiveTheme(preference);
        set({ theme, themePreference: preference });
        if (typeof localStorage !== 'undefined') {
          try {
            const parsed = JSON.parse(localStorage.getItem(STORAGE_KEYS.SETTINGS) || '{}');
            const current =
              parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
            if (current.theme !== preference) {
              const next = { ...current, theme: preference };
              localStorage.setItem(STORAGE_KEYS.SETTINGS, JSON.stringify(next));
              masterBus.emit('SETTINGS_UPDATED', {
                settings: next,
                userId,
                source: 'interface-theme',
              });
            }
          } catch (error) {
            console.warn('[SettingsStore] Could Not Mirror Interface Mode:', error);
          }
        }
        if (typeof document !== 'undefined') {
          document.documentElement.setAttribute('data-theme', theme);
          document.documentElement.style.colorScheme = theme;
        }
      };
      return {
        theme: 'dark',
        themePreference: 'dark',
        receiveTheme: apply,

        setTheme: (preference, userId) => {
          apply(preference, userId);
          masterBus.emit('UI_THEME_CHANGED', { key: 'theme', value: preference, userId });
        },
      };
    },
    {
      // NOTE (2026-08-26): this key is exclusively zustand's. STORAGE_KEYS.SETTINGS
      // in src/lib/storage.ts used to be the same string, and this middleware
      // clobbered every save SettingsPage made. If you add another persisted
      // store, give it its own name and check src/lib/storage.ts first.
      name: 'club-arena-settings',
      merge: (persisted, current) => {
        const saved = persisted as Partial<SettingsState> | undefined;
        const preference = saved?.themePreference ?? saved?.theme;
        if (preference !== 'light' && preference !== 'dark' && preference !== 'auto')
          return current;
        return { ...current, themePreference: preference, theme: effectiveTheme(preference) };
      },
    }
  )
);
