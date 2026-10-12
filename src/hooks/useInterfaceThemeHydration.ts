import { useEffect, useLayoutEffect, useState } from 'react';
import { masterBus } from '../core/MasterBus';
import { readLocalSession } from '../lib/authUtils';
import { ownProfile } from '../lib/ownProfile';
import { type InterfaceThemePreference, useSettingsStore } from '../stores/useSettingsStore';
import { reportError } from '../utils/errorReporter';

export const INTERFACE_THEME_READ_TIMEOUT_MS = 6_000;
const INTERFACE_THEME_READ_ATTEMPTS = 2;

type ProfileThemeResult = {
  data: { settings?: unknown } | null;
  error: unknown;
};

class InterfaceThemeReadTimeoutError extends Error {
  constructor() {
    super('Interface theme read timed out');
    this.name = 'InterfaceThemeReadTimeoutError';
  }
}

function preferenceFromSettings(settings: unknown): InterfaceThemePreference {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return 'dark';
  const value = (settings as Record<string, unknown>).theme;
  return value === 'light' || value === 'dark' || value === 'auto' ? value : 'dark';
}

function withReadTimeout<T>(operation: PromiseLike<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(
      () => reject(new InterfaceThemeReadTimeoutError()),
      INTERFACE_THEME_READ_TIMEOUT_MS
    );
    Promise.resolve(operation).then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timer);
        reject(error);
      }
    );
  });
}

async function readProfileTheme(userId: string): Promise<InterfaceThemePreference> {
  let lastError: unknown;
  for (let attempt = 0; attempt < INTERFACE_THEME_READ_ATTEMPTS; attempt += 1) {
    try {
      const query = ownProfile(userId).select('settings').maybeSingle();
      const result = await withReadTimeout(query as unknown as PromiseLike<ProfileThemeResult>);
      if (result.error) throw result.error;
      return preferenceFromSettings(result.data?.settings);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

/**
 * Binds first-paint interface mode to the authenticated account, then
 * reconciles its durable profiles.settings value. Cleanup plus a store-side
 * owner check makes a late A response inert after switching to B in one tab.
 */
export function useInterfaceThemeHydration(enabled = true): void {
  const [userId, setUserId] = useState<string | null>(() =>
    enabled ? readLocalSession()?.userId || null : null
  );

  useLayoutEffect(() => {
    if (!enabled) return undefined;

    const sessionUserId = readLocalSession()?.userId || null;
    setUserId((current) => (current === sessionUserId ? current : sessionUserId));

    return masterBus.subscribe('AUTH_STATE_CHANGED', (event) => {
      const next = event.payload.isAuthenticated ? event.payload.userId || null : null;
      setUserId((current) => (current === next ? current : next));
    });
  }, [enabled]);

  useLayoutEffect(() => {
    if (!enabled) return;
    useSettingsStore.getState().bindInterfaceThemeScope(userId);
  }, [enabled, userId]);

  useEffect(() => {
    if (!enabled || !userId) return undefined;
    let current = true;

    void readProfileTheme(userId)
      .then((preference) => {
        if (!current) return;
        useSettingsStore.getState().applyAuthoritativeInterfaceTheme(userId, preference);
      })
      .catch((error) => {
        if (!current) return;
        useSettingsStore.getState().markInterfaceThemeHydrationFailed(userId);
        reportError(error, 'InterfaceThemeHydration.Profile_settings_read_failed');
      });

    return () => {
      current = false;
    };
  }, [enabled, userId]);
}

export default useInterfaceThemeHydration;
