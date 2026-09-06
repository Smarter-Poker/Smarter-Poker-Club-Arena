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

/* ═══ READING A PAGE THAT IS STILL MOVING (2026-09-02) ════════════════════
   `production-daily-missions.spec.ts` failed on EVERY post-deploy run with

     Error: page.evaluate: Execution context was destroyed, most likely
     because of a navigation
       at support/DailyMissionsPage.ts:123

   and that is a defect in this harness, not in production. `signIn` navigates
   with `waitUntil: 'domcontentloaded'`, which returns while the SPA is still
   settling its own auth redirect, and then reads `localStorage` - so the
   context the read was issued against is torn down under it.

   The read is correct and worth keeping; it is the check that the run is
   signed in as the RESERVED account and not as somebody else, which is the
   one thing standing between a production certification and it mutating the
   wrong player. So the read is retried through the navigation rather than
   removed, and ONLY for the destroyed-context family of errors - a real
   failure (wrong account, bad JSON) still throws on the first attempt. */
const NAVIGATION_ATE_THE_CONTEXT =
  /Execution context was destroyed|Target closed|frame was detached|Most likely the page has been closed/i;

async function evaluateThroughNavigation<R>(page: Page, fn: () => R): Promise<R> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => {});
      return await page.evaluate(fn);
    } catch (error) {
      if (!NAVIGATION_ATE_THE_CONTEXT.test(String(error))) throw error;
      lastError = error;
      await page.waitForTimeout(400);
    }
  }
  throw lastError;
}

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
    /* The disposable account was already authenticated through Supabase when
       it was created. Seed that exact, server-issued session into the shared
       same-origin SSO key in every environment. Production previously threw
       the known-good session away and raced the Hub login UI instead; after a
       successful redirect the Club Arena bundle could mount before the Hub's
       localStorage write, making the safety check observe "no user". Global
       setup already certifies the Hub login UI with the standing E2E account.
       This page-specific run must deterministically prove it is the isolated
       account before it mutates mission state. */
    const { data: apiSession } = await account.client.auth.getSession();
    if (apiSession.session?.user.id !== account.id) {
      throw new Error(`Reserved Daily Missions account ${account.id} has no matching API session.`);
    }
    await context.addInitScript(
      ({ session, userId }) => {
        localStorage.setItem('club_arena_welcome_accepted', 'true');
        // This suite certifies the page-specific Daily Mission alert controls
        // later in the journey. Mark the unrelated app-level first-run push
        // question as already answered so its deliberate 20-second modal does
        // not cover economy controls or invoke browser permission.
        localStorage.setItem(`sp_firstrun_notif_v2_${userId}`, String(Date.now()));
        // Hub and Club Arena use this same key on the same origin. Seeding the
        // already-authenticated disposable account avoids a second login race.
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

    await evaluateThroughNavigation(page, () =>
      localStorage.setItem('club_arena_welcome_accepted', 'true')
    );
    if (new URL(page.url()).pathname !== notificationsURL.pathname) {
      await page.goto(notificationsURL.toString(), {
        waitUntil: 'domcontentloaded',
        timeout: DAILY_MISSIONS_RESPONSE_TIMEOUT,
      });
    }
    if (page.url().includes('/auth')) {
      throw new Error(`Temporary Daily Missions account ${account.id} did not remain signed in.`);
    }
    let authenticatedUserId = '';
    for (let attempt = 0; attempt < 30; attempt += 1) {
      authenticatedUserId = await evaluateThroughNavigation(page, () => {
        const raw = localStorage.getItem('smarter-poker-auth');
        if (!raw) return '';
        const session = JSON.parse(raw);
        return session?.user?.id || session?.currentSession?.user?.id || '';
      });
      if (authenticatedUserId) break;
      if (page.url().includes('/auth')) break;
      await page.waitForTimeout(500);
    }
    if (authenticatedUserId !== account.id) {
      throw new Error(
        `Daily Missions signed in as ${authenticatedUserId || 'no user'} instead of reserved account ${account.id}.`
      );
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
    await expect(
      this.page.getByRole('heading', { name: 'Daily Challenges', level: 1 })
    ).toBeVisible({
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

  async firstRerollButton(): Promise<Locator> {
    // The dashboard is live data. A player can finish every mission in the
    // initially selected Daily tier before another device opens this surface;
    // the atomic reroll contract applies to any unfinished assigned row, so
    // select the first tier that truthfully exposes one instead of assuming
    // Daily must always have an unfinished card.
    for (const tier of ['Daily', 'Weekly', 'Monthly'] as const) {
      await this.chooseTier(tier);
      const candidate = this.page
        .getByRole('button', { name: /^Reroll .+ For 10 Diamonds$/ })
        .first();
      if (await candidate.isVisible().catch(() => false)) return candidate;
    }
    throw new Error('The live dashboard exposed no unfinished mission that could be rerolled.');
  }

  async chooseTier(name: 'Daily' | 'Weekly' | 'Monthly') {
    const tab = this.page.getByRole('tab', { name: new RegExp(`^${name}`) });
    await tab.click();
    await expect(tab).toHaveAttribute('aria-selected', 'true');
  }
}
