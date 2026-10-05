import { beforeEach, describe, expect, it } from 'vitest';
import {
  patchSettingsPageCacheTheme,
  readSettingsPageCache,
  retireLegacyGlobalSettingsPageCache,
  settingsPageCacheKey,
  writeSettingsPageCache,
} from '../../src/lib/settingsPageCache';

describe('Settings page cache account isolation', () => {
  beforeEach(() => localStorage.clear());

  it('keeps complete settings under separate account keys', () => {
    writeSettingsPageCache('user-a', { theme: 'light', soundVolume: 12 });
    writeSettingsPageCache('user-b', { theme: 'dark', soundVolume: 88 });

    expect(readSettingsPageCache('user-a')).toEqual({ theme: 'light', soundVolume: 12 });
    expect(readSettingsPageCache('user-b')).toEqual({ theme: 'dark', soundVolume: 88 });
    expect(settingsPageCacheKey('user-a')).not.toBe(settingsPageCacheKey('user-b'));
  });

  it('patches only the selected account and preserves its other preferences', () => {
    writeSettingsPageCache('user-a', { theme: 'dark', cardBack: 'classic_red' });
    writeSettingsPageCache('user-b', { theme: 'dark', cardBack: 'classic_blue' });

    expect(patchSettingsPageCacheTheme('user-a', 'auto')).toEqual({
      theme: 'auto',
      cardBack: 'classic_red',
    });
    expect(readSettingsPageCache('user-b')).toEqual({
      theme: 'dark',
      cardBack: 'classic_blue',
    });
  });

  it('never promotes the retired device-global blob into an account', () => {
    localStorage.setItem(
      'club-arena-user-settings',
      JSON.stringify({ theme: 'light', soundVolume: 1 })
    );

    expect(readSettingsPageCache('user-b')).toBeNull();
    retireLegacyGlobalSettingsPageCache();
    expect(localStorage.getItem('club-arena-user-settings')).toBeNull();
  });
});
