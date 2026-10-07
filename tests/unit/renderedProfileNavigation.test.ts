import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Page } from '@playwright/test';
import { navigateToRenderedProfile } from '../e2e/support/renderedProfileNavigation';

function fixture(
  options: {
    redirected?: boolean;
    clickFails?: boolean;
    headingMissing?: boolean;
    studioOpen?: boolean;
  } = {}
) {
  let current = 'https://smarter.poker/hub/club-arena/';
  const heading = {
    waitFor: vi.fn(async () => {
      if (options.headingMissing) throw new Error('Profile content never rendered');
    }),
  };
  const close = { click: vi.fn(async () => undefined) };
  const studio = {
    isVisible: vi.fn(async () => options.studioOpen === true),
    getByRole: vi.fn(() => close),
    waitFor: vi.fn(async () => undefined),
  };
  const profile = {
    click: vi.fn(async () => {
      if (options.clickFails) throw new Error('Profile control refused');
      current = options.redirected
        ? 'https://smarter.poker/auth/login'
        : 'https://smarter.poker/hub/club-arena/profile';
    }),
  };
  const page = {
    goto: vi.fn(async () => {
      throw new Error('Commit notification lost despite rendered document');
    }),
    url: vi.fn(() => current),
    getByRole: vi.fn((role: string) => (role === 'dialog' ? studio : profile)),
    waitForURL: vi.fn(async () => undefined),
    locator: vi.fn(() => heading),
  };
  return { page: page as unknown as Page, goto: page.goto, profile, studio, close, heading };
}
afterEach(() => vi.restoreAllMocks());
describe('rendered production profile navigation', () => {
  it('uses one real profile gesture without a full-document lifecycle dependency', async () => {
    const f = fixture();
    await navigateToRenderedProfile(f.page, 'https://smarter.poker/hub/club-arena/', 60_000);
    expect(f.goto).not.toHaveBeenCalled();
    expect(f.profile.click).toHaveBeenCalledOnce();
    expect(f.heading.waitFor).toHaveBeenCalledOnce();
  });
  it('closes only the actual Table Studio before using the profile control', async () => {
    const f = fixture({ studioOpen: true });
    await navigateToRenderedProfile(f.page, 'https://smarter.poker/hub/club-arena/', 60_000);
    expect(f.close.click).toHaveBeenCalledOnce();
    expect(f.studio.waitFor).toHaveBeenCalledWith(expect.objectContaining({ state: 'hidden' }));
    expect(f.profile.click).toHaveBeenCalledOnce();
    expect(f.close.click.mock.invocationCallOrder[0]).toBeLessThan(
      f.profile.click.mock.invocationCallOrder[0]
    );
  });
  it('refuses an auth redirect even if an unrelated heading exists', async () => {
    const f = fixture({ redirected: true });
    await expect(
      navigateToRenderedProfile(f.page, 'https://smarter.poker/hub/club-arena/', 60_000)
    ).rejects.toThrow('Profile navigation did not reach its protected route');
    expect(f.heading.waitFor).not.toHaveBeenCalled();
  });
  it('uses only the remaining original deadline for each operation', async () => {
    vi.spyOn(Date, 'now').mockReturnValueOnce(1000).mockReturnValue(56000);
    const f = fixture();
    await navigateToRenderedProfile(f.page, 'https://smarter.poker/hub/club-arena/', 60_000);
    expect(f.profile.click).toHaveBeenCalledWith({ timeout: 5000 });
    expect(f.heading.waitFor).toHaveBeenCalledWith({ state: 'visible', timeout: 5000 });
  });
  it('refuses a failed gesture without retrying or navigating around it', async () => {
    const f = fixture({ clickFails: true });
    await expect(
      navigateToRenderedProfile(f.page, 'https://smarter.poker/hub/club-arena/', 60_000)
    ).rejects.toThrow('Profile control refused');
    expect(f.profile.click).toHaveBeenCalledOnce();
    expect(f.goto).not.toHaveBeenCalled();
    expect(f.heading.waitFor).not.toHaveBeenCalled();
  });
  it('refuses the expected route if actual profile content never renders', async () => {
    const f = fixture({ headingMissing: true });
    await expect(
      navigateToRenderedProfile(f.page, 'https://smarter.poker/hub/club-arena/', 60_000)
    ).rejects.toThrow('Profile content never rendered');
  });
});
