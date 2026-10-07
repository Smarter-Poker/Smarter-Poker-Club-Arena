import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Page } from '@playwright/test';
import { navigateToRenderedProfile } from '../e2e/support/renderedProfileNavigation';

function fixture(
  options: {
    lifecycleLost?: boolean;
    redirected?: boolean;
    navigationFails?: boolean;
    headingMissing?: boolean;
  } = {}
) {
  const heading = {
    waitFor: vi.fn(async () => {
      if (options.headingMissing) throw new Error('Profile content never rendered');
    }),
  };
  const page = {
    goto: vi.fn(async (_url: string, navigation: { waitUntil: string }) => {
      if (options.navigationFails) throw new Error('Document request failed');
      if (options.lifecycleLost && navigation.waitUntil !== 'commit')
        throw new Error('DOMContentLoaded never arrived despite rendered profile');
    }),
    url: vi.fn(() =>
      options.redirected
        ? 'https://smarter.poker/auth/login'
        : 'https://smarter.poker/hub/club-arena/profile'
    ),
    locator: vi.fn(() => heading),
  };
  return { page: page as unknown as Page, goto: page.goto, heading };
}

afterEach(() => vi.restoreAllMocks());
describe('rendered production profile navigation', () => {
  it('accepts the committed, visibly rendered profile when the lifecycle notification is lost', async () => {
    const f = fixture({ lifecycleLost: true });
    await navigateToRenderedProfile(f.page, 'https://smarter.poker/hub/club-arena/', 60_000);
    expect(f.goto).toHaveBeenCalledOnce();
    expect(f.heading.waitFor).toHaveBeenCalledOnce();
  });
  it('refuses an auth redirect even if an unrelated heading happens to exist', async () => {
    const f = fixture({ redirected: true });
    await expect(
      navigateToRenderedProfile(f.page, 'https://smarter.poker/hub/club-arena/', 60_000)
    ).rejects.toThrow('Profile navigation did not reach its protected route');
    expect(f.heading.waitFor).not.toHaveBeenCalled();
  });
  it('spends only the remaining original deadline on rendered content', async () => {
    vi.spyOn(Date, 'now').mockReturnValueOnce(1000).mockReturnValue(56000);
    const f = fixture();
    await navigateToRenderedProfile(f.page, 'https://smarter.poker/hub/club-arena/', 60_000);
    expect(f.heading.waitFor).toHaveBeenCalledWith({ state: 'visible', timeout: 5000 });
  });
  it('refuses a document failure without retrying navigation', async () => {
    const f = fixture({ navigationFails: true });
    await expect(
      navigateToRenderedProfile(f.page, 'https://smarter.poker/hub/club-arena/', 60_000)
    ).rejects.toThrow('Document request failed');
    expect(f.goto).toHaveBeenCalledOnce();
    expect(f.heading.waitFor).not.toHaveBeenCalled();
  });
  it('refuses a committed document whose actual profile never renders', async () => {
    const f = fixture({ headingMissing: true });
    await expect(
      navigateToRenderedProfile(f.page, 'https://smarter.poker/hub/club-arena/', 60_000)
    ).rejects.toThrow('Profile content never rendered');
    expect(f.goto).toHaveBeenCalledOnce();
  });
});
