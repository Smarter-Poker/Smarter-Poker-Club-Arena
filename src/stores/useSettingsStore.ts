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
        masterBus.emit('UI_THEME_CHANGED' as any, { key: 'theme', value: theme });
      },
    }),
    {
      name: 'club-arena-settings',
    }
  )
);
