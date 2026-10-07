import AxeBuilder from '@axe-core/playwright';
import { financialConsoleEnumCopy } from './helpers/financial-console-copy';
import { readFileSync } from 'node:fs';
import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import {
  FINANCIAL_ADMIN_CONSOLE_READ_ONLY_RPC_PATHS,
  FINANCIAL_ADMIN_QUARANTINED_SHELL_POST_PATHS,
  installFinancialReadOnlyGuard,
  type FinancialReadOnlyGuard,
} from './helpers/financial-readonly-guard';

const DEFAULT_E2E_CLUB_ID = 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4';
const CLUB_ID = process.env.E2E_CLUB_ID || DEFAULT_E2E_CLUB_ID;
const DISPOSABLE_EMAIL = /^ca-customization-cert-postdeploy-.*@example\.invalid$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_IN_COPY = /\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/i;
const RAW_ENUM_IN_COPY = /\b[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+\b/;
const LOADING_COPY = /\b(?:Loading|Reading|Checking|Verifying|Preparing|Synchronizing)\b/i;
const REVENUE_RPC_GLOB = '**/rest/v1/rpc/ca_financial_admin_revenue_series';

type LinkedConsole = Readonly<{
  label: string;
  relativeUrl: string;
  heading: string;
  root: string;
}>;

const LINKED_CONSOLES: readonly LinkedConsole[] = [
  {
    label: 'Club Disputes',
    relativeUrl: `clubs/${encodeURIComponent(CLUB_ID)}/disputes`,
    heading: 'Club Disputes',
    root: '.dispute-management-page',
  },
  {
    label: 'Rate Audit Trail',
    relativeUrl: `rate-audit?club=${encodeURIComponent(CLUB_ID)}`,
    heading: 'Rate Audit Trail',
    root: 'main',
  },
  {
    label: 'Agent Portal',
    relativeUrl: 'agent-portal',
    heading: 'Agent Command Center',
    root: 'main',
  },
  {
    label: 'Credit Admin',
    relativeUrl: `credit-admin?club=${encodeURIComponent(CLUB_ID)}`,
    heading: 'Credit Admin',
    root: 'main',
  },
  {
    label: 'Settlement History',
    relativeUrl: `settlement-history?club=${encodeURIComponent(CLUB_ID)}`,
    heading: 'Settlement History',
    root: 'main',
  },
  {
    label: 'Settlement Center',
    relativeUrl: `settlement-dashboard?club=${encodeURIComponent(CLUB_ID)}`,
    heading: 'Weekly Accounting',
    root: 'main',
  },
  {
    label: 'CSV Exports',
    relativeUrl: `clubs/${encodeURIComponent(CLUB_ID)}/financials`,
    heading: 'Financials',
    root: '.financials-page',
  },
] as const;

const guards = new WeakMap<Page, FinancialReadOnlyGuard>();

function configuredBase(testInfo: TestInfo): string {
  const raw = String(testInfo.project.use.baseURL || 'http://localhost:5173/hub/club-arena/');
  return raw.endsWith('/') ? raw : `${raw}/`;
}

function expectedUrl(relativeUrl: string, testInfo: TestInfo): URL {
  return new URL(relativeUrl.replace(/^\//, ''), configuredBase(testInfo));
}

function requireDisposableProductionIdentity(): { id: string; email: string } {
  if (!process.env.SP_EMAIL || !process.env.SP_PASS) {
    test.skip(true, 'The reserved authenticated production fixture is required.');
  }

  const fixturePath = process.env.E2E_TEST_ACCOUNT_FILE;
  if (!fixturePath) throw new Error('The reserved account record is required.');
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
    id?: unknown;
    email?: unknown;
    createdAt?: unknown;
  };
  const id = String(fixture.id || '');
  const email = String(fixture.email || '');
  const createdAt = Date.parse(String(fixture.createdAt || ''));
  if (
    !UUID.test(id) ||
    !DISPOSABLE_EMAIL.test(email) ||
    email !== process.env.SP_EMAIL ||
    !Number.isFinite(createdAt) ||
    Math.abs(Date.now() - createdAt) > 2 * 60 * 60_000
  ) {
    throw new Error('Refusing Financial Admin proof outside this run reserved identity.');
  }
  return { id, email };
}

async function suppressDisposableDailyBonusRead(page: Page, userId: string): Promise<void> {
  await page.addInitScript((disposableUserId) => {
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Chicago',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
    localStorage.setItem(`ca_daily_bonus_seen:${disposableUserId}:${today}`, '1');
  }, userId);
}

async function expectExactRoute(
  page: Page,
  relativeUrl: string,
  testInfo: TestInfo
): Promise<void> {
  const expected = expectedUrl(relativeUrl, testInfo);
  await expect
    .poll(
      () => {
        const actual = new URL(page.url());
        return `${actual.pathname}${actual.search}`;
      },
      { timeout: 60_000 }
    )
    .toBe(`${expected.pathname}${expected.search}`);
  await expect(page).not.toHaveURL(/\/auth(?:\/|\?|$)/);
}

async function waitForTerminalSurface(page: Page, rootSelector: string): Promise<void> {
  const root = page.locator(rootSelector).first();
  await expect
    .poll(
      async () =>
        root
          .locator('[aria-busy="true"]:visible, [role="status"]:visible')
          .filter({ hasText: LOADING_COPY })
          .count(),
      { timeout: 90_000 }
    )
    .toBe(0);
}

async function visibleRoot(page: Page, selector: string): Promise<Locator> {
  const root = page.locator(selector).first();
  await expect(root).toBeVisible({ timeout: 60_000 });
  return root;
}

async function expectPaintedConsole(root: Locator): Promise<void> {
  const head = root.locator('.sc__head:visible').first();
  await expect(head).toBeVisible();
  const background = await head.evaluate((element) => getComputedStyle(element).backgroundImage);
  expect(background).toContain('/assets/club-buttons/console/');
}

async function expectNoRawBackendCopy(root: Locator): Promise<void> {
  const copy = await root.evaluate((element) => (element as HTMLElement).innerText);
  expect(copy).not.toMatch(UUID_IN_COPY);
  expect(await root.evaluate(financialConsoleEnumCopy)).not.toMatch(RAW_ENUM_IN_COPY);
}

async function expectTouchSafeControls(root: Locator): Promise<void> {
  const undersized = await root
    .locator(
      'button:visible, a[href]:visible, summary:visible, input:visible, select:visible, textarea:visible, [role="button"]:visible, [role="tab"]:visible'
    )
    .evaluateAll((controls) => {
      const number = (value: string): number => {
        const parsed = Number.parseFloat(value);
        return Number.isFinite(parsed) ? parsed : 0;
      };
      const pseudoSize = (control: Element, pseudo: '::before' | '::after') => {
        const style = getComputedStyle(control, pseudo);
        if (style.content === 'none' || style.display === 'none') return { width: 0, height: 0 };
        const rect = control.getBoundingClientRect();
        const left = number(style.left);
        const right = number(style.right);
        const top = number(style.top);
        const bottom = number(style.bottom);
        return {
          width: Math.max(
            number(style.width),
            rect.width + Math.max(0, -left) + Math.max(0, -right)
          ),
          height: Math.max(
            number(style.height),
            rect.height + Math.max(0, -top) + Math.max(0, -bottom)
          ),
        };
      };
      return controls
        .map((control) => {
          const rect = control.getBoundingClientRect();
          const before = pseudoSize(control, '::before');
          const after = pseudoSize(control, '::after');
          return {
            label:
              control.getAttribute('aria-label') ||
              control.getAttribute('placeholder') ||
              (control.textContent || '').trim().slice(0, 80),
            width: Math.max(rect.width, before.width, after.width),
            height: Math.max(rect.height, before.height, after.height),
          };
        })
        .filter((control) => control.width < 44 || control.height < 44);
    });
  expect(undersized).toEqual([]);

  const undersizedTextInputs = await root
    .locator(
      'input:not([type="checkbox"]):not([type="radio"]):visible, select:visible, textarea:visible'
    )
    .evaluateAll((controls) =>
      controls
        .map((control) => ({
          label: control.getAttribute('aria-label') || control.getAttribute('placeholder') || '',
          fontSize: Number.parseFloat(getComputedStyle(control).fontSize),
        }))
        .filter((control) => control.fontSize < 16)
    );
  expect(undersizedTextInputs).toEqual([]);
}

async function expectKeyboardEntry(root: Locator): Promise<void> {
  const target = root
    .locator(
      'button:not([disabled]):visible, a[href]:visible, summary:visible, input:not([disabled]):visible, select:not([disabled]):visible, [role="tab"]:visible'
    )
    .first();
  if ((await target.count()) === 0) return;
  await target.focus();
  await expect(target).toBeFocused();
}

async function expectMobileConsoleQuality(
  page: Page,
  rootSelector: string,
  { axe = true }: { axe?: boolean } = {}
): Promise<void> {
  const root = await visibleRoot(page, rootSelector);
  expect(await page.evaluate(() => window.innerWidth)).toBe(393);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    )
  ).toBeLessThanOrEqual(1);
  expect(
    await root.evaluate((element) => element.scrollWidth - element.clientWidth)
  ).toBeLessThanOrEqual(1);
  await expectPaintedConsole(root);
  await expectNoRawBackendCopy(root);
  await expectTouchSafeControls(root);
  await expectKeyboardEntry(root);

  if (axe) {
    const results = await new AxeBuilder({ page }).include(rootSelector).analyze();
    expect(
      results.violations.filter((violation) =>
        ['serious', 'critical'].includes(violation.impact || '')
      )
    ).toEqual([]);
  }
}

async function openConsole(
  page: Page,
  relativeUrl: string,
  heading: string,
  rootSelector: string,
  testInfo: TestInfo
): Promise<void> {
  await page.goto(relativeUrl, { waitUntil: 'domcontentloaded' });
  await expectExactRoute(page, relativeUrl, testInfo);
  await expect(page.getByRole('heading', { name: heading, exact: true }).first()).toBeVisible({
    timeout: 60_000,
  });
  await waitForTerminalSurface(page, rootSelector);
}

async function expectLinkedConsoleOutcome(page: Page, route: LinkedConsole): Promise<void> {
  switch (route.label) {
    case 'Club Disputes':
      await expect(page.getByRole('tablist', { name: 'Filter Disputes By Status' })).toBeVisible();
      await expect(page.getByText('Dispute Docket Unavailable', { exact: true })).toHaveCount(0);
      break;
    case 'Rate Audit Trail':
      await expect(page.getByRole('group', { name: 'Rate Type' })).toBeVisible();
      await expect(page.getByRole('group', { name: 'Reading Window' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Retry', exact: true })).toHaveCount(0);
      break;
    case 'Agent Portal': {
      const wallets = page.getByLabel('Agent Wallets');
      const refusal = page.locator('main').last().getByRole('alert').first();
      await expect
        .poll(async () => (await wallets.count()) + (await refusal.count()))
        .toBeGreaterThan(0);
      if ((await refusal.count()) > 0) {
        await expect(refusal).toContainText(
          /(?:Open Your Club|Choose A Club|Agent Wallet Could Not Be Verified)/
        );
        await expect(page.getByRole('button', { name: 'Open Clubs', exact: true })).toBeVisible();
      }
      break;
    }
    case 'Credit Admin':
      await expect(page.getByLabel('Credit Exposure Summary')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Retry', exact: true })).toHaveCount(0);
      break;
    case 'Settlement History':
      await expect(page.getByLabel('Settlement Summary')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Retry', exact: true })).toHaveCount(0);
      break;
    case 'Settlement Center':
      await expect(
        page
          .getByRole('region', { name: 'Club Weekly Summaries', exact: true })
          .getByRole('heading', { name: 'Club Weekly Summaries', exact: true, level: 3 })
      ).toBeVisible();
      await expect(page.getByLabel('Club Transaction Records')).toBeVisible();
      break;
    case 'CSV Exports':
      // Exact: CSV Exports also mounts RakeReports' "Rake Reporting Window"
      // tablist, which a substring match resolves alongside this one.
      await expect(
        page.getByRole('tablist', { name: 'Reporting Window', exact: true })
      ).toBeVisible();
      await expect(page.getByText('Financials Unavailable', { exact: true })).toHaveCount(0);
      break;
  }
}

test.describe('Financial Admin production console certificate', () => {
  test.describe.configure({ mode: 'serial', timeout: 360_000 });
  test.use({ serviceWorkers: 'block' });

  test.beforeEach(async ({ page }) => {
    const identity = requireDisposableProductionIdentity();
    await page.setViewportSize({ width: 393, height: 852 });
    // The global entry prompt otherwise invokes a VOLATILE status RPC that can
    // open a bonus-day row. Keep this certificate server-read-only by using the
    // component's own per-day browser marker for the disposable identity.
    await suppressDisposableDailyBonusRead(page, identity.id);
    guards.set(
      page,
      await installFinancialReadOnlyGuard(page, {
        allowedRpcPaths: FINANCIAL_ADMIN_CONSOLE_READ_ONLY_RPC_PATHS,
        quarantinedPostPaths: FINANCIAL_ADMIN_QUARANTINED_SHELL_POST_PATHS,
      })
    );
  });

  test.afterEach(async ({ page }) => {
    const guard = guards.get(page);
    if (!guard) return;
    try {
      guard.assertNoViolations();
    } finally {
      await guard.dispose();
      guards.delete(page);
    }
  });

  test('loads the scoped hub and wires every role-appropriate tool door', async ({
    page,
  }, testInfo) => {
    await openConsole(page, 'financial-admin', 'Financial Admin Hub', 'main', testInfo);
    const tools = page.getByRole('navigation', { name: 'Financial Tools' });
    await expect(tools).toBeVisible();

    for (const route of LINKED_CONSOLES) {
      const link = tools.getByRole('link').filter({ hasText: route.label });
      await expect(link, `${route.label} must be wired from the hub`).toHaveCount(1);
      const href = await link.getAttribute('href');
      expect(href).not.toBeNull();
      const actual = new URL(href!, page.url());
      const expected = expectedUrl(route.relativeUrl, testInfo);
      expect(`${actual.pathname}${actual.search}`).toBe(`${expected.pathname}${expected.search}`);
      await expect(link).not.toHaveAttribute('target', '_blank');
    }

    await expect(tools.getByRole('link').filter({ hasText: 'Diamond Staff Desk' })).toHaveCount(0);
    await expect(tools.getByRole('link').filter({ hasText: 'System Health' })).toHaveCount(0);
    await expect(tools.getByRole('link').filter({ hasText: 'Drift Incidents' })).toHaveCount(0);
    await expectMobileConsoleQuality(page, 'main');

    const keyboardDoor = tools.getByRole('link').filter({ hasText: 'Rate Audit Trail' });
    await keyboardDoor.focus();
    await expect(keyboardDoor).toBeFocused();
    await page.keyboard.press('Enter');
    await expectExactRoute(page, `rate-audit?club=${encodeURIComponent(CLUB_ID)}`, testInfo);
    await expect(
      page.getByRole('heading', { name: 'Rate Audit Trail', exact: true }).first()
    ).toBeVisible();
  });

  test('renders every directly linked club console at exactly 393px without unsafe copy or controls', async ({
    page,
  }, testInfo) => {
    for (const route of LINKED_CONSOLES) {
      await test.step(route.label, async () => {
        await openConsole(page, route.relativeUrl, route.heading, route.root, testInfo);
        await expectLinkedConsoleOutcome(page, route);
        await expectMobileConsoleQuality(page, route.root);
      });
    }
  });

  test('renders a bounded hub error and recovers through the read-only retry', async ({
    page,
  }, testInfo) => {
    let faultArmed = true;
    const failFirstRevenueRead = async (route: import('@playwright/test').Route) => {
      if (!faultArmed) {
        await route.fallback();
        return;
      }
      faultArmed = false;
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'Reserved Read Failure' }),
      });
    };
    await page.route(REVENUE_RPC_GLOB, failFirstRevenueRead);

    await page.goto('financial-admin', { waitUntil: 'domcontentloaded' });
    await expectExactRoute(page, 'financial-admin', testInfo);
    const financialReadError = page
      .getByRole('alert')
      .filter({ hasText: 'Financial Status Could Not Be Verified' });
    await expect(financialReadError).toContainText(
      'Financial Status Could Not Be Verified. No All Clear Is Being Shown.',
      { timeout: 60_000 }
    );
    const retry = page.getByRole('button', { name: 'Retry Financial Reading', exact: true });
    await expect(retry).toBeVisible();
    await retry.focus();
    await expect(retry).toBeFocused();

    await page.unroute(REVENUE_RPC_GLOB, failFirstRevenueRead);
    await retry.click();
    await expect(page.getByRole('navigation', { name: 'Financial Tools' })).toBeVisible({
      timeout: 90_000,
    });
    await expect(financialReadError).toHaveCount(0);
    await expectMobileConsoleQuality(page, 'main', { axe: false });
  });

  test('fails closed on every directly linked platform-only console', async ({
    page,
  }, testInfo) => {
    // A refused platform route lands on the router's root, which is its
    // basename WITHOUT a trailing slash (src/lib/appBase.ts ROUTER_BASENAME,
    // '/hub/club-arena'): <Navigate to="/"> resolves to the basename itself.
    // The configured base URL's '/hub/club-arena/' is the same lobby, but it is
    // not the URL the guard writes, so pinning it could never pass.
    const arenaRoot = expectedUrl('', testInfo).pathname.replace(/\/$/, '');
    for (const route of ['diamond-staff-desk', 'financial-health'] as const) {
      await test.step(route, async () => {
        await page.goto(route, { waitUntil: 'domcontentloaded' });
        await expect.poll(() => new URL(page.url()).pathname, { timeout: 60_000 }).toBe(arenaRoot);
        await page.evaluate(() => window.stop());
        await expect(page).not.toHaveURL(/\/auth(?:\/|\?|$)/);
        await expect(
          page.getByRole('heading', { name: /Diamond Staff Desk|Financial Health/ })
        ).toHaveCount(0);
      });
    }

    await page.goto('financial-incidents', { waitUntil: 'domcontentloaded' });
    await expectExactRoute(page, 'financial-admin', testInfo);
    await expect(
      page.getByRole('heading', { name: 'Financial Admin Hub', exact: true }).first()
    ).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole('heading', { name: 'Drift Incidents', exact: true })).toHaveCount(
      0
    );
  });
});
