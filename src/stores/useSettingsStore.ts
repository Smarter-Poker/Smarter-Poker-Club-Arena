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
interface SettingsState {
  theme: 'dark' | 'light';
  setTheme: (theme: 'dark' | 'light', userId?: string) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      theme: 'dark',

      setTheme: (theme, userId) => {
        set({ theme });
        /* Keep the full Settings page's separate, deliberately namespaced
           local cache in step with Table Studio. Without this mirror, the
           interface changed immediately but /settings reopened with the old
           mode and could save it back over the new account preference. */
        if (typeof localStorage !== 'undefined') {
          try {
            const raw = localStorage.getItem(STORAGE_KEYS.SETTINGS);
            const parsed = raw ? JSON.parse(raw) : {};
            const current =
              parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
            const next = { ...current, theme };
            localStorage.setItem(STORAGE_KEYS.SETTINGS, JSON.stringify(next));
            masterBus.emit('SETTINGS_UPDATED', { settings: next });
          } catch (error) {
            console.warn('[SettingsStore] Could Not Mirror Interface Mode:', error);
          }
        }
        // Apply immediately even on direct /table routes where Shell may not
        // be the component that initiated the change. The persisted store is
        // still the source of truth; this keeps the visible chrome and the
        // selected control in the same frame.
        if (typeof document !== 'undefined') {
          document.documentElement.setAttribute('data-theme', theme);
          document.documentElement.style.colorScheme = theme;
        }
        masterBus.emit('UI_THEME_CHANGED', { key: 'theme', value: theme, userId });
      },
    }),
    {
      // NOTE (2026-08-26): this key is exclusively zustand's. STORAGE_KEYS.SETTINGS
      // in src/lib/storage.ts used to be the same string, and this middleware
      // clobbered every save SettingsPage made. If you add another persisted
      // store, give it its own name and check src/lib/storage.ts first.
      name: 'club-arena-settings',
    }
  )
);
