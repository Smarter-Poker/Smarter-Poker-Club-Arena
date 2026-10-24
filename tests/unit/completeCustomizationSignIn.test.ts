import { describe, expect, it, vi } from 'vitest';
import type { Page } from '@playwright/test';
import { completeCustomizationSignIn } from '../e2e/support/completeCustomizationSignIn';

const destination = 'https://smarter.poker/hub/club-arena/notifications';
function browserAt(initial: string) {
  let current = initial;
  const events: string[] = [];
  const page = {
    url: () => current,
    waitForURL: vi.fn(async (match: string | ((url: URL) => boolean)) => {
      if (
        typeof match === 'function' &&
        current.endsWith('/hub/verify-phone') &&
        events.includes('wait')
      ) {
        await Promise.resolve();
      }
      expect(typeof match === 'string' ? current === match : match(new URL(current))).toBe(true);
      events.push('wait');
    }),
    getByRole: vi.fn((role, options) => {
      expect([role, options]).toEqual(['button', { name: 'Skip For Now', exact: true }]);
      return {
        click: async () => {
          events.push('skip');
          current = 'https://smarter.poker/hub';
        },
      };
    }),
    goto: vi.fn(async (url: string) => {
      events.push('arena');
      current = url;
    }),
  };
  return { page: page as unknown as Page, events };
}

describe('customization sign-in destination readiness', () => {
  it('completes optional phone welcome before entering Arena', async () => {
    const { page, events } = browserAt('https://smarter.poker/hub/verify-phone');
    await completeCustomizationSignIn(page, destination);
    expect(events).toEqual(['wait', 'skip', 'wait', 'arena', 'wait']);
    expect(page.url()).toBe(destination);
  });
  it('restores the protected destination after a Hub redirect', async () => {
    const { page } = browserAt('https://smarter.poker/hub');
    await completeCustomizationSignIn(page, destination);
    expect(page.goto).toHaveBeenCalledOnce();
    expect(page.getByRole).not.toHaveBeenCalled();
  });
  it('does not reload an already reached protected destination', async () => {
    const { page } = browserAt(destination);
    await completeCustomizationSignIn(page, destination);
    expect(page.goto).not.toHaveBeenCalled();
  });
  it.each(['https://smarter.poker/auth/login', 'https://other.example/hub'])(
    'does not accept %s as signed in',
    async (url) => {
      const { page } = browserAt(url);
      await expect(completeCustomizationSignIn(page, destination)).rejects.toThrow();
      expect(page.goto).not.toHaveBeenCalled();
    }
  );
});
