import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { masterBus } from '../core/MasterBus';

interface SettingsState {
  soundEnabled: boolean;
  fourColorDeck: boolean;
  theme: 'dark' | 'light';
  notificationsEnabled: boolean;

  toggleSound: () => void;
  toggleFourColorDeck: () => void;
  toggleNotifications: () => void;
  setTheme: (theme: 'dark' | 'light') => void;
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
      setTheme: (theme) => {
        set({ theme });
        masterBus.emit('UI_THEME_CHANGED', { key: 'theme', value: theme });
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
