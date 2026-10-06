import { expect, test, type Locator, type Page } from '@playwright/test';
import { ADMIN_CLUB_OPERATION_ROUTES } from '../support/clubOperationRoutes';
import { assertRendered, expectRoute } from './utils';

/* The general fixture club belongs to a union and correctly refuses local
   Table Management. The post-deploy harness also grants this account admin
   access to a reserved standalone club, which is the only fixture on which
   every one of the 27 registry destinations can render positively. */
const CLUB_ID = process.env.E2E_TEMPLATE_CLUB_ID || '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3';
const UNION_MEMBER_CLUB_ID = process.env.E2E_CLUB_ID || 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4';
const HAS_AUTH = Boolean(process.env.SP_EMAIL && process.env.SP_PASS);

function matchesDestination(url: URL, target: string): boolean {
  const expected = new URL(target, 'https://club-arena.invalid');
  const clubPrefix = `/clubs/${CLUB_ID}`;
  const canonicalClubSuffix = expected.pathname.startsWith(clubPrefix)
    ? expected.pathname.slice(clubPrefix.length)
    : null;
  const pathMatches =
    canonicalClubSuffix !== null
      ? new RegExp(
          `/clubs/[^/]+${canonicalClubSuffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`
        ).test(url.pathname)
      : expected.pathname === '/'
        ? url.pathname === '/' || url.pathname.endsWith('/hub/club-arena/')
        : url.pathname.endsWith(expected.pathname);
  if (!pathMatches) return false;
  return [...expected.searchParams].every(
    ([key, value]) =>
      url.searchParams.getAll(key).length === 1 && url.searchParams.get(key) === value
  );
}

async function expectDestination(page: Page, target: string): Promise<void> {
  await expect(page, `navigation did not reach ${target}`).toHaveURL(
    (url) => matchesDestination(url, target),
    { timeout: 15_000 }
  );
}

async function openClubHamburger(page: Page): Promise<Locator> {
  const source = `clubs/${CLUB_ID}/operations`;
  await expectRoute(page, source, { expectText: 'Club Operations' });
  await expectDestination(page, `/${source}`);

  return openCurrentHamburger(page);
}

async function openCurrentHamburger(page: Page): Promise<Locator> {
  const opener = page.getByRole('button', { name: 'Open Menu' }).first();
  await expect(opener).toBeVisible({ timeout: 15_000 });
  await opener.click();

  const dialog = page.getByRole('dialog', { name: 'Poker Arena' });
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  return dialog;
}

async function clickAndProve(
  page: Page,
  surface: Locator,
  label: string,
  target: string
): Promise<void> {
  const destination = surface
    .getByRole('button', { name: new RegExp(`^${label}(?:\\s|$)`) })
    .first();
  await expect(destination, `${label} is missing from the authenticated club menu`).toBeVisible({
    timeout: 15_000,
  });
  await destination.click();
  await expectDestination(page, target);
  await assertRendered(page, target);
}

test.describe('Reserved Admin - every Club Operations registry route', () => {
  test.skip(!HAS_AUTH, 'SP_EMAIL/SP_PASS are required for the reserved admin route fixture.');

  for (const operation of ADMIN_CLUB_OPERATION_ROUTES) {
    test(`${operation.id} renders its live club-scoped destination`, async ({ page }) => {
      const path = `clubs/${CLUB_ID}/${operation.suffix}`;
      await expectRoute(page, path);
      await expectDestination(page, `/${path}`);

      await expect(page.getByRole('navigation', { name: 'Club Operations Sections' })).toBeVisible({
        timeout: 20_000,
      });
      await expect(
        page.locator('#main-content').getByText(operation.marker, { exact: false }).first(),
        `${path} never rendered its own positive content marker`
      ).toBeVisible({ timeout: 30_000 });
      await expect(
        page
          .locator('#main-content')
          .getByRole('alert')
          .filter({ hasText: 'This Surface Could Not Load' })
      ).toHaveCount(0);
      await expect(page.getByText('This Tool Is Restricted', { exact: true })).toHaveCount(0);
      await expect(page.getByText('Club Operations Is Restricted', { exact: true })).toHaveCount(0);
      await expect(page.getByText('Financials Are Restricted', { exact: true })).toHaveCount(0);
    });
  }
});

test.describe('Reserved Admin - conditional club hamburger doors', () => {
  test.skip(!HAS_AUTH, 'SP_EMAIL/SP_PASS are required for the reserved admin menu fixture.');

  const conditionalNavigationLinks = [
    { group: 'Club Operations', label: 'Club Lobby', target: `/clubs/${CLUB_ID}` },
    {
      group: 'Club Operations',
      label: 'Table Management',
      target: `/clubs/${CLUB_ID}/table-management`,
    },
    { group: 'Club Operations', label: 'Agent Dashboard', target: '/agent-dashboard' },
    {
      group: 'Club Operations',
      label: 'Operations Center',
      target: `/clubs/${CLUB_ID}/operations`,
    },
    {
      group: 'Club Operations',
      label: 'Advertise Your Club',
      target: `/clubs/${CLUB_ID}/advertise`,
    },
    {
      group: 'Wallet & Rewards',
      label: 'Cashier',
      target: `/clubs/${CLUB_ID}/cashier`,
    },
  ];

  for (const link of conditionalNavigationLinks) {
    test(`clicks the conditional ${link.group} link: ${link.label}`, async ({ page }) => {
      const dialog = await openClubHamburger(page);
      const group = dialog.locator(`section[aria-label="${link.group}"]`);
      await expect(group).toBeVisible();
      await clickAndProve(page, group, link.label, link.target);
    });
  }

  const contextActions = [
    { label: 'Table Management', target: `/clubs/${CLUB_ID}/table-management` },
    { label: 'Invite Players', target: `/clubs/${CLUB_ID}/settings` },
    { label: 'Open Finance & Risk', target: `/clubs/${CLUB_ID}/finance` },
  ];

  for (const action of contextActions) {
    test(`clicks the conditional club context action: ${action.label}`, async ({ page }) => {
      const dialog = await openClubHamburger(page);
      const context = dialog.locator('[aria-label="Context Actions"]');
      await expect(context).toBeVisible();
      await clickAndProve(page, context, action.label, action.target);
      if (action.label === 'Invite Players') {
        await expect(page.getByRole('heading', { name: 'Share Club' })).toBeVisible({
          timeout: 15_000,
        });
        const copyInviteLink = page.getByRole('button', { name: 'Copy Invite Link' });
        await expect(copyInviteLink).toBeVisible({ timeout: 15_000 });
        await expect(copyInviteLink).toBeEnabled();
      }
    });
  }

  test('keeps the direct canonical union rail and hamburger Table Management door wired', async ({
    page,
  }) => {
    test.setTimeout(90_000);

    /* This is a served-bundle wiring proof, not a production-authority mutation.
       The isolated account already owns zero-balance membership in a union
       member club. Intercept only the two boolean authority observations so
       the browser can exercise the positive union chrome without granting the
       disposable identity a real union role that the guarded cleanup would
       correctly refuse to erase. Database authority remains covered by the
       predicate contracts and exact migration readback. */
    const authorityJsonHeaders = {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,HEAD,POST,PATCH,PUT,DELETE,OPTIONS',
      'access-control-allow-headers':
        'accept-profile,authorization,apikey,content-profile,content-type,prefer,x-client-info',
      'content-type': 'application/json',
    };
    for (const rpc of ['fn_is_union_operator', 'ca_can_oversee_union']) {
      await page.route(`**/rest/v1/rpc/${rpc}`, async (route) => {
        if (route.request().method() === 'OPTIONS') {
          await route.fulfill({ status: 204, headers: authorityJsonHeaders });
          return;
        }
        await route.fulfill({ status: 200, headers: authorityJsonHeaders, body: 'true' });
      });
    }

    await expectRoute(page, `clubs/${UNION_MEMBER_CLUB_ID}/operations`, {
      expectText: 'Club Operations',
    });
    const clubDialog = await openCurrentHamburger(page);
    const clubContext = clubDialog.locator('[aria-label="Context Actions"]');
    const unionTableDoor = clubContext.getByRole('button', { name: 'Table Management' }).first();
    await expect(unionTableDoor).toBeVisible({ timeout: 15_000 });
    await unionTableDoor.click();

    const canonicalUnionTableRoute =
      /\/unions\/(?![0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\/|$))[^/?#]+\/table-management(?:[?#]|$)/i;
    await expect(page).toHaveURL(canonicalUnionTableRoute, { timeout: 20_000 });
    await assertRendered(page, 'canonical union table management');

    const rail = page.getByRole('navigation', { name: 'Union Network Sections' });
    for (const label of [
      'Operations',
      'Table Management',
      'Union Data',
      'Statements',
      'Settlement',
      'Diamond Costs',
    ]) {
      await expect(rail.getByRole('link', { name: label })).toBeVisible({ timeout: 15_000 });
    }

    const unionDialog = await openCurrentHamburger(page);
    await expect(
      unionDialog
        .locator('[aria-label="Context Actions"]')
        .getByRole('button', { name: 'Table Management' })
    ).toBeVisible({ timeout: 15_000 });
  });
});
