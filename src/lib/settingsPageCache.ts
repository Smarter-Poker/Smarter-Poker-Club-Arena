import { STORAGE_KEYS } from './storage';

export const SETTINGS_PAGE_CACHE_PREFIX = 'ca_user_settings:';

export type CachedInterfaceThemePreference = 'dark' | 'light' | 'auto';

export function settingsPageCacheKey(userId: string): string {
  return `${SETTINGS_PAGE_CACHE_PREFIX}${userId}`;
}

function isSettingsRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Settings are account-owned even when cached for first paint. A single
 * device-global blob lets the next person using the browser inherit and save
 * the previous account's preferences.
 */
export function readSettingsPageCache(
  userId: string | null | undefined
): Record<string, unknown> | null {
  if (!userId || typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(settingsPageCacheKey(userId));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isSettingsRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function writeSettingsPageCache(
  userId: string | null | undefined,
  settings: Record<string, unknown>
): boolean {
  if (!userId || typeof localStorage === 'undefined') return false;
  try {
    localStorage.setItem(settingsPageCacheKey(userId), JSON.stringify(settings));
    return true;
  } catch {
    // Private-mode storage failure cannot block the durable server save.
    return false;
  }
}

export function patchSettingsPageCacheTheme(
  userId: string | null | undefined,
  theme: CachedInterfaceThemePreference
): Record<string, unknown> | null {
  const current = readSettingsPageCache(userId);
  if (!userId || !current) return null;
  const next = { ...current, theme };
  writeSettingsPageCache(userId, next);
  return next;
}

export function removeSettingsPageCache(userId: string | null | undefined): void {
  if (!userId || typeof localStorage === 'undefined') return;
  try {
    localStorage.removeItem(settingsPageCacheKey(userId));
  } catch {
    // Best-effort device cleanup; account deletion remains server-authoritative.
  }
}

export function retireLegacyGlobalSettingsPageCache(): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.removeItem(STORAGE_KEYS.SETTINGS);
  } catch {
    // The account fence still holds because no reader consumes the legacy key.
  }
}
