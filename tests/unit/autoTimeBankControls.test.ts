import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_USER_TABLE_SETTINGS,
  TABLE_SETTINGS_META,
} from '../../src/hooks/useUserTableSettings';
import {
  announceNativePause,
  announceNativeResume,
  isNativeAppActive,
  NATIVE_PAUSE_EVENT,
  NATIVE_RESUME_EVENT,
} from '../../src/lib/nativeResume';

afterEach(() => announceNativeResume());
describe('auto time bank controls and app presence', () => {
  it('defaults on and is available in both table settings and quick settings', () => {
    expect(DEFAULT_USER_TABLE_SETTINGS.auto_time_bank).toBe(true);
    expect(TABLE_SETTINGS_META.find((m) => m.key === 'auto_time_bank')?.quick).toBe(true);
    const menu = readFileSync('src/components/navigation/HamburgerMenu.tsx', 'utf8');
    expect(menu).toContain("toggleTableSetting('auto_time_bank')");
    expect(menu).toContain('aria-checked={tableSettings.auto_time_bank}');
    const tableMenu = readFileSync('src/components/table/TableMenu.tsx', 'utf8');
    expect(tableMenu).toContain("togglePlayerSetting('auto_time_bank')");
    expect(tableMenu).toContain("id: 'auto-time-bank'");
  });
  it('publishes pause before its listeners run and resume before recovery listeners run', () => {
    const pause = vi.fn(() => expect(isNativeAppActive()).toBe(false));
    const resume = vi.fn(() => expect(isNativeAppActive()).toBe(true));
    window.addEventListener(NATIVE_PAUSE_EVENT, pause);
    window.addEventListener(NATIVE_RESUME_EVENT, resume);
    announceNativePause();
    announceNativeResume();
    expect(pause).toHaveBeenCalledOnce();
    expect(resume).toHaveBeenCalledOnce();
    window.removeEventListener(NATIVE_PAUSE_EVENT, pause);
    window.removeEventListener(NATIVE_RESUME_EVENT, resume);
  });
});
