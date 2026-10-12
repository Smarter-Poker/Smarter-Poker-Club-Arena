import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEffect } from 'react';
import type { Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readProfileInterfaceMode } from '../e2e/support/profileInterfaceMode';

vi.mock('../../src/core/MasterBus', () => ({ masterBus: { emit: vi.fn() } }));
import { useSettingsStore } from '../../src/stores/useSettingsStore';

const page = {
  locator: (selector: string) => ({
    getAttribute: async (name: string) => document.querySelector(selector)!.getAttribute(name),
  }),
} as unknown as Page;

// The preference response is held, but its receiving store and DOM are real.
function Profile({ preference }: { preference: Promise<'dark' | 'light'> }) {
  useEffect(() => {
    let live = true;
    void preference.then((mode) => {
      if (live) useSettingsStore.getState().receiveTheme(mode, 'other-player');
    });
    return () => {
      live = false;
    };
  }, [preference]);
  return <h1 id="profile-heading">Other Player</h1>;
}

beforeEach(() => {
  document.documentElement.removeAttribute('data-theme');
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.style.colorScheme = '';
});

describe('the other account baseline waits for its actual interface mode', () => {
  it.each(['dark', 'light'] as const)(
    'waits beyond the heading before capturing %s',
    async (mode) => {
      let resolve!: (value: 'dark' | 'light') => void;
      const preference = new Promise<'dark' | 'light'>((done) => {
        resolve = done;
      });
      render(<Profile preference={preference} />);
      expect(document.querySelector('#profile-heading')?.textContent).toBe('Other Player');
      // Reproduces the former eager capture: a visible heading does not make this a string.
      expect(await page.locator('html').getAttribute('data-theme')).toBeNull();
      let settled = false;
      const ready = readProfileInterfaceMode(page, 1_000).then((value) => {
        settled = true;
        return value;
      });
      await new Promise((done) => setTimeout(done, 20));
      expect(settled).toBe(false);
      await act(async () => resolve(mode));
      const baseline = await ready;
      expect(baseline).toBe(mode);
      expect(document.documentElement.getAttribute('data-theme')).toBe(baseline);
      // A cross-account event cannot repaint this account after its scope binds.
      act(() =>
        useSettingsStore.getState().receiveTheme(mode === 'dark' ? 'light' : 'dark', 'wrong-player')
      );
      expect(document.documentElement.getAttribute('data-theme')).toBe(baseline);
    }
  );

  it.each([null, 'auto', '', 'unexpected'])(
    'refuses an unready or invalid %s baseline',
    async (mode) => {
      if (mode !== null) document.documentElement.setAttribute('data-theme', mode);
      await expect(readProfileInterfaceMode(page, 25)).rejects.toThrow('Timeout 25ms exceeded');
    }
  );

  it('keeps the bounded readiness and exact other-account assertion in the live journey', () => {
    const spec = readFileSync(
      resolve(__dirname, '../e2e/production-customization-realtime.spec.ts'),
      'utf8'
    );
    expect(spec).toContain(
      'const otherMode = await readProfileInterfaceMode(otherPage, PRODUCTION_RESPONSE_TIMEOUT)'
    );
    expect(spec).toContain("toHaveAttribute('data-theme', otherMode)");
    expect(spec).not.toContain('otherMode!');
    expect(spec.indexOf('const otherMode =')).toBeLessThan(spec.indexOf('const accountEdit ='));
  });
});
