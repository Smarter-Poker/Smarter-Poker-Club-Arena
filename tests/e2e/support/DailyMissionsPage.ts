import {
  expect,
  type BrowserContext,
  type Locator,
  type Page,
  type Response,
} from '@playwright/test';

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
      ({ session, userId }) => {
        localStorage.setItem('club_arena_welcome_accepted', 'true');
        // This suite certifies the page-specific Daily Mission alert controls
        // later in the journey. Mark the unrelated app-level first-run push
        // question as already answered so its deliberate 20-second modal does
        // not cover economy controls or invoke browser permission.
        localStorage.setItem(`sp_firstrun_notif_v2_${userId}`, String(Date.now()));
        // The production Hub owns /auth/login. A standalone branch bundle has
        // no Hub process, so seed the same shared SSO key from the already
        // authenticated disposable-account client for local pre-publish UI.
        if (session) localStorage.setItem('smarter-poker-auth', JSON.stringify(session));
      },
      { session: apiSession.session, userId: account.id }
    );
    const page = await context.newPage();
    const notificationsURL = new URL('notifications', baseURL);
    await page.goto(notificationsURL.toString(), {
      waitUntil: 'domcontentloaded',
      timeout: DAILY_MISSIONS_RESPONSE_TIMEOUT,
    });
    // Local certification already has the shared SSO session, while production
    // redirects to the Hub login. Race those real outcomes instead of waiting
    // a fixed auth timeout after loading the asset-heavy home route first.
    const waitForEntrySurface = (timeout: number) =>
      page
        .waitForFunction(
          () =>
            window.location.pathname.includes('/auth') ||
            Boolean(document.querySelector('[data-profile-gate-status]')),
          undefined,
          { timeout }
        )
        .then(() => true)
        .catch(() => false);

    if (!(await waitForEntrySurface(20_000))) {
      // The application shell exposes this same bounded recovery when its main
      // module never imports (most commonly a stale or starved preview cache).
      // Recover before the measured Daily Missions cold load begins.
      await page.evaluate(async () => {
        sessionStorage.removeItem('__club_arena_recovery');
        if ('caches' in window) {
          await Promise.all((await caches.keys()).map((key) => caches.delete(key)));
        }
      });
      await page.reload({
        waitUntil: 'domcontentloaded',
        timeout: DAILY_MISSIONS_RESPONSE_TIMEOUT,
      });
      if (!(await waitForEntrySurface(30_000))) {
        throw new Error('Club Arena shell did not expose Auth or the profile gate after recovery.');
      }
    }

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
    if (new URL(page.url()).pathname !== notificationsURL.pathname) {
      await page.goto(notificationsURL.toString(), {
        waitUntil: 'domcontentloaded',
        timeout: DAILY_MISSIONS_RESPONSE_TIMEOUT,
      });
    }
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

  /**
   * Remount an Arena route through the live BrowserRouter without replacing
   * the document. Playwright disables HTTP cache as soon as page.route() is
   * installed; forcing a full navigation after installing an RPC fault route
   * therefore measures an artificial uncached asset waterfall and can time
   * out before DOMContentLoaded even though the target UI is already mounted.
   *
   * This dispatches the same popstate transition the browser's Back/Forward
   * controls use. Callers still assert the destination UI and its live network
   * contract; only the unrelated document reload is removed.
   */
  async navigateWithinArena(route: string): Promise<void> {
    const target = new URL(route, this.baseURL).toString();
    await this.page.evaluate((href) => {
      window.history.pushState({}, '', href);
      window.dispatchEvent(new PopStateEvent('popstate', { state: window.history.state }));
    }, target);
  }

  dashboardResponses(): Promise<Response> {
    return this.page.waitForResponse(
      (response) => response.url().includes('/rest/v1/rpc/get_daily_challenge_dashboard'),
      { timeout: DAILY_MISSIONS_RESPONSE_TIMEOUT }
    );
  }

  /**
   * Fixed artwork navigation is intentionally opaque and interactive. Browser
   * visibility APIs do not subtract fixed overlays, so a control can be
   * reported visible while its click point belongs to the footer. Always
   * center mission controls before activation, then prove their entire hit
   * target is above the live footer geometry.
   */
  async placeControlInSafeViewport(control: Locator): Promise<void> {
    await control.evaluate((element) => {
      element.scrollIntoView({ behavior: 'auto', block: 'center', inline: 'nearest' });
    });
    await expect
      .poll(async () => {
        const [controlBox, footerBox] = await Promise.all([
          control.boundingBox(),
          this.page.getByRole('navigation', { name: 'Club Arena' }).boundingBox(),
        ]);
        if (!controlBox || !footerBox) return false;
        return controlBox.y + controlBox.height <= footerBox.y - 8;
      })
      .toBe(true);
  }

  rerollButton() {
    return this.page.getByRole('button', { name: /^Reroll .+ For 10 Diamonds$/ }).first();
  }

  async chooseTier(name: 'Daily' | 'Weekly' | 'Monthly') {
    const tab = this.page.getByRole('tab', { name: new RegExp(`^${name}`) });
    await tab.click();
    await expect(tab).toHaveAttribute('aria-selected', 'true');
  }
}
