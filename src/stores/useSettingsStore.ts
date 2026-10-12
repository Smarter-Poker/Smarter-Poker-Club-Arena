import { create } from 'zustand';
import { masterBus } from '../core/MasterBus';
import {
  patchSettingsPageCacheTheme,
  retireLegacyGlobalSettingsPageCache,
} from '../lib/settingsPageCache';

/**
 * This store owns only the interface mode. Sound, haptics and card display
 * remain owned by their existing table/gate stores.
 */
export type InterfaceTheme = 'dark' | 'light';
export type InterfaceThemePreference = InterfaceTheme | 'auto';
export type InterfaceThemeHydrationState = 'idle' | 'loading' | 'ready' | 'error';

export const INTERFACE_THEME_CACHE_PREFIX = 'ca_interface_theme:';
const LEGACY_GLOBAL_STORE_KEY = 'club-arena-settings';

export function interfaceThemeCacheKey(userId: string): string {
  return `${INTERFACE_THEME_CACHE_PREFIX}${userId}`;
}

function isInterfaceThemePreference(value: unknown): value is InterfaceThemePreference {
  return value === 'dark' || value === 'light' || value === 'auto';
}

export function effectiveInterfaceTheme(preference: InterfaceThemePreference): InterfaceTheme {
  return preference === 'auto'
    ? typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-color-scheme: light)').matches
      ? 'light'
      : 'dark'
    : preference;
}

export function readCachedInterfaceTheme(userId: string): InterfaceThemePreference | null {
  if (!userId || typeof localStorage === 'undefined') return null;
  try {
    const value = localStorage.getItem(interfaceThemeCacheKey(userId));
    return isInterfaceThemePreference(value) ? value : null;
  } catch {
    return null;
  }
}

function writeCachedInterfaceTheme(userId: string, preference: InterfaceThemePreference): void {
  if (!userId || typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(interfaceThemeCacheKey(userId), preference);
  } catch {
    // The in-memory and DOM values still update; the profile remains durable.
  }
}

function applyInterfaceThemeToDocument(theme: InterfaceTheme): void {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute('data-theme', theme);
  document.documentElement.style.colorScheme = theme;
}

function mirrorSettingsPageTheme(
  userId: string | null,
  preference: InterfaceThemePreference
): void {
  const next = patchSettingsPageCacheTheme(userId, preference);
  if (!next) return;
  masterBus.emit('SETTINGS_UPDATED', {
    settings: next,
    userId: userId || undefined,
    source: 'interface-theme',
  });
}

function retireUnsafeGlobalThemeCache(): void {
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.removeItem(LEGACY_GLOBAL_STORE_KEY);
    } catch {
      // A storage failure cannot prevent the in-memory account fence.
    }
  }
  retireLegacyGlobalSettingsPageCache();
}

interface SettingsState {
  /** Effective light/dark value for the currently bound account. */
  theme: InterfaceTheme;
  /** Durable choice, including Auto. */
  themePreference: InterfaceThemePreference;
  interfaceThemeUserId: string | null;
  interfaceThemeScopeReady: boolean;
  interfaceThemeHydrationState: InterfaceThemeHydrationState;
  setTheme: (theme: InterfaceThemePreference, userId?: string) => void;
  receiveTheme: (theme: InterfaceThemePreference, userId?: string) => void;
  bindInterfaceThemeScope: (userId: string | null) => void;
  applyAuthoritativeInterfaceTheme: (
    userId: string,
    preference: InterfaceThemePreference
  ) => boolean;
  markInterfaceThemeHydrationFailed: (userId: string) => void;
}

export const useSettingsStore = create<SettingsState>((set, get) => {
  const applyForOwner = (
    owner: string | null,
    preference: InterfaceThemePreference,
    hydrationState: InterfaceThemeHydrationState
  ) => {
    const theme = effectiveInterfaceTheme(preference);
    set({ theme, themePreference: preference, interfaceThemeHydrationState: hydrationState });
    if (owner) writeCachedInterfaceTheme(owner, preference);
    mirrorSettingsPageTheme(owner, preference);
    applyInterfaceThemeToDocument(theme);
  };

  return {
    theme: 'dark',
    themePreference: 'dark',
    interfaceThemeUserId: null,
    interfaceThemeScopeReady: false,
    interfaceThemeHydrationState: 'idle',

    bindInterfaceThemeScope: (userId) => {
      const current = get();
      if (current.interfaceThemeScopeReady && current.interfaceThemeUserId === userId) return;

      retireUnsafeGlobalThemeCache();
      const preference = userId ? readCachedInterfaceTheme(userId) || 'dark' : 'dark';
      const theme = effectiveInterfaceTheme(preference);
      set({
        theme,
        themePreference: preference,
        interfaceThemeUserId: userId,
        interfaceThemeScopeReady: true,
        interfaceThemeHydrationState: userId ? 'loading' : 'idle',
      });
      applyInterfaceThemeToDocument(theme);
      mirrorSettingsPageTheme(userId, preference);
    },

    applyAuthoritativeInterfaceTheme: (userId, preference) => {
      const current = get();
      if (!userId || !current.interfaceThemeScopeReady || current.interfaceThemeUserId !== userId) {
        return false;
      }
      applyForOwner(userId, preference, 'ready');
      return true;
    },

    markInterfaceThemeHydrationFailed: (userId) => {
      const current = get();
      if (!current.interfaceThemeScopeReady || current.interfaceThemeUserId !== userId) return;
      set({ interfaceThemeHydrationState: 'error' });
    },

    receiveTheme: (preference, explicitUserId) => {
      const current = get();
      const owner = explicitUserId || current.interfaceThemeUserId;
      if (explicitUserId && current.interfaceThemeScopeReady) {
        if (current.interfaceThemeUserId !== explicitUserId) return;
      } else if (explicitUserId && !current.interfaceThemeScopeReady) {
        set({ interfaceThemeUserId: explicitUserId, interfaceThemeScopeReady: true });
      }
      applyForOwner(owner, preference, owner ? 'ready' : 'idle');
    },

    setTheme: (preference, explicitUserId) => {
      const current = get();
      const owner = explicitUserId || current.interfaceThemeUserId;

      if (explicitUserId && current.interfaceThemeScopeReady) {
        if (current.interfaceThemeUserId !== explicitUserId) return;
      } else if (explicitUserId && !current.interfaceThemeScopeReady) {
        set({
          interfaceThemeUserId: explicitUserId,
          interfaceThemeScopeReady: true,
          interfaceThemeHydrationState: 'ready',
        });
      }

      applyForOwner(owner, preference, owner ? 'ready' : 'idle');
      masterBus.emit('UI_THEME_CHANGED', {
        key: 'theme',
        value: preference,
        userId: owner || undefined,
      });
    },
  };
});
