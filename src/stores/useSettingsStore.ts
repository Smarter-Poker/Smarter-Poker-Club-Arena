import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { masterBus } from '../core/MasterBus';
import { STORAGE_KEYS } from '../lib/storage';

interface SettingsState {
  soundEnabled: boolean;
  fourColorDeck: boolean;
  theme: 'dark' | 'light';
  notificationsEnabled: boolean;

  toggleSound: () => void;
  toggleFourColorDeck: () => void;
  toggleNotifications: () => void;
  setTheme: (theme: 'dark' | 'light', userId?: string) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      soundEnabled: true,
      fourColorDeck: false,
      theme: 'dark',
      notificationsEnabled: true,

      toggleSound: () => set((state) => ({ soundEnabled: !state.soundEnabled })),
      toggleFourColorDeck: () => set((state) => ({ fourColorDeck: !state.fourColorDeck })),
      toggleNotifications: () =>
        set((state) => ({ notificationsEnabled: !state.notificationsEnabled })),
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
