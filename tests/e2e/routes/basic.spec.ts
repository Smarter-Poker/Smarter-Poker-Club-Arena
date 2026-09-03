import { test, expect } from '@playwright/test';
import { expectRoute, assertRendered } from './utils';

test.describe('Authentication Flow', () => {
  test('should route the retired clubs index to the canonical lobby', async ({ page }) => {
    await page.goto('clubs');

    await expect
      .poll(() => new URL(page.url()).pathname, { timeout: 10000 })
      .toMatch(/^(?:\/hub\/club-arena)?\/?$|^\/auth(?:\/|$)/);
    if (new URL(page.url()).pathname.startsWith('/auth')) test.skip();
    await assertRendered(page, 'canonical lobby');
  });

  test('should render home for an authenticated session or skip at auth', async ({ page }) => {
    await expectRoute(page, '');
  });
});

test.describe('Navigation', () => {
  test('should navigate to play overview', async ({ page }) => {
    await expectRoute(page, 'play', { expectText: 'Play & Review' });
  });

  test('should navigate to clubs page', async ({ page }) => {
    await expectRoute(page, 'clubs');
  });

  test('should navigate to tournaments page', async ({ page }) => {
    await expectRoute(page, 'tournaments');
  });

  test('should navigate to leaderboard page', async ({ page }) => {
    await expectRoute(page, 'leaderboard');
  });

  test('should navigate to community overview', async ({ page }) => {
    await expectRoute(page, 'community', { expectText: 'Community Center' });
  });

  test('should navigate to rewards overview', async ({ page }) => {
    await expectRoute(page, 'rewards', { expectText: 'Rewards Center' });
  });
});

test.describe('VIP Page', () => {
  test('should render VIP for an authenticated session or skip at auth', async ({ page }) => {
    await expectRoute(page, 'vip');
  });
});
