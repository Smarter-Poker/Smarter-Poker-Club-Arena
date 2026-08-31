import { expect, type BrowserContext, type Page, type Response } from '@playwright/test';

import { ensurePlayableProfile } from './ensurePlayableProfile';
import type { TemporaryCustomizationAccount } from './temporaryCustomizationAccount';

export const DAILY_MISSIONS_RESPONSE_TIMEOUT = 60_000;

export class DailyMissionsPage {
  readonly page: Page;
  readonly baseURL: string;

  constructor(page: Page, baseURL: string) {
    this.page = page;
    this.baseURL = baseURL;
  }

  static async signIn(
    context: BrowserContext,
    baseURL: string,
    account: TemporaryCustomizationAccount
  ): Promise<DailyMissionsPage> {
    const localBundle = ['127.0.0.1', 'localhost'].includes(new URL(baseURL).hostname);
    const { data: apiSession } = localBundle
      ? await account.client.auth.getSession()
      : { data: { session: null } };
    await context.addInitScript(
      ({ session }) => {
        localStorage.setItem('club_arena_welcome_accepted', 'true');
        // The production Hub owns /auth/login. A standalone branch bundle has
        // no Hub process, so seed the same shared SSO key from the already
        // authenticated disposable-account client for local pre-publish UI.
        if (session) localStorage.setItem('smarter-poker-auth', JSON.stringify(session));
      },
      { session: apiSession.session }
    );
    const page = await context.newPage();
    await page.goto(baseURL, {
      waitUntil: 'domcontentloaded',
      timeout: DAILY_MISSIONS_RESPONSE_TIMEOUT,
    });
    await page
      .waitForURL((url) => url.pathname.includes('/auth'), { timeout: 20_000 })
      .catch(() => undefined);

    if (page.url().includes('/auth')) {
      const appBasePath = new URL(baseURL).pathname;
      if (!new URL(page.url()).pathname.startsWith(appBasePath)) {
        // Vite's base-path guard exposes a helpful link when an application
        // redirect targets /auth directly during local-bundle certification.
        // Follow the same auth route under the configured Club Arena base.
        const authURL = new URL('auth', baseURL);
        authURL.searchParams.set('redirect', appBasePath);
        await page.goto(authURL.toString(), {
          waitUntil: 'domcontentloaded',
          timeout: DAILY_MISSIONS_RESPONSE_TIMEOUT,
        });
      }
      const email = page.locator('input[type="email"]').first();
      const password = page.locator('input[type="password"]').first();
      await expect(email).toBeVisible({ timeout: 30_000 });
      await email.fill(account.email);
      await password.fill(account.password);
      const titled = page.locator('button[type="submit"][title="Sign In"]').first();
      const submit = (await titled.count())
        ? titled
        : page.locator('form button[type="submit"], button[type="submit"]').first();
      await submit.click();
      await page.waitForURL((url) => !url.pathname.includes('/auth'), { timeout: 45_000 });
    }

    await page.evaluate(() => localStorage.setItem('club_arena_welcome_accepted', 'true'));
    await page.goto(new URL('notifications', baseURL).toString(), {
      waitUntil: 'domcontentloaded',
      timeout: DAILY_MISSIONS_RESPONSE_TIMEOUT,
    });
    if (page.url().includes('/auth')) {
      throw new Error(`Temporary Daily Missions account ${account.id} did not remain signed in.`);
    }
    await ensurePlayableProfile(page);
    await expect(page.getByRole('button', { name: 'Open Menu' }).first()).toBeVisible({
      timeout: 30_000,
    });
    return new DailyMissionsPage(page, baseURL);
  }

  async open(): Promise<number> {
    const startedAt = Date.now();
    await this.page.goto(new URL('challenges', this.baseURL).toString(), {
      waitUntil: 'domcontentloaded',
      timeout: DAILY_MISSIONS_RESPONSE_TIMEOUT,
    });
    await expect(this.page.getByRole('heading', { name: 'Daily Missions', level: 1 })).toBeVisible({
      timeout: DAILY_MISSIONS_RESPONSE_TIMEOUT,
    });
    await expect(this.page.locator('#daily-missions')).toHaveAttribute('aria-busy', 'false', {
      timeout: DAILY_MISSIONS_RESPONSE_TIMEOUT,
    });
    return Date.now() - startedAt;
  }

  dashboardResponses(): Promise<Response> {
    return this.page.waitForResponse(
      (response) => response.url().includes('/rest/v1/rpc/get_daily_challenge_dashboard'),
      { timeout: DAILY_MISSIONS_RESPONSE_TIMEOUT }
    );
  }

  rerollButton() {
    return this.page.getByRole('button', { name: /^Reroll .+ for 10 diamonds$/ }).first();
  }

  async chooseTier(name: 'Daily' | 'Weekly' | 'Monthly') {
    const tab = this.page.getByRole('tab', { name: new RegExp(`^${name}`) });
    await tab.click();
    await expect(tab).toHaveAttribute('aria-selected', 'true');
  }
}
