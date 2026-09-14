import { test, expect, type Page } from '@playwright/test';
import { expectRoute, assertRendered } from './utils';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THESE TWO ROUTES WROTE 243 ROWS INTO THE PRODUCTION BUG TABLE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `table/demo` and `table/nonexistent-table-id` are correct tests of a route
 * that must survive an id that is not an id, and they stay. What they were
 * ALSO doing, on every deploy from 2026-09-02 to 2026-09-12, was exercising a
 * real defect and silently filing it:
 *
 *   TournamentStartingTicker put the raw path segment into a uuid column, so
 *   Postgres raised 22P02, the ticker's catch called reportError, and
 *   HorseBugReporter's console.error hook wrote a row to `horse_bug_reports`
 *   in PRODUCTION - once per poll, from a Playwright process, categorised as a
 *   `tournament_bug` because the component's name contains "Tournament".
 *
 * This job runs against production (BASE_URL https://smarter.poker/hub/...),
 * so the suite was not observing the platform, it was writing to it. Nobody
 * noticed for ten days because the rows looked like a tournament incident.
 *
 * So the spec now asserts what it should always have asserted: an id that is
 * not an id is handled AT THE BOUNDARY, quietly, with nothing on the console
 * and no Postgres error text leaking onto the felt. The route that caused the
 * flood is now the route that proves it cannot come back.
 */

/** The signature of an unchecked route segment reaching a typed column. */
const BOUNDARY_ERROR = /22P0\d|invalid input syntax for type|TournamentStartingTicker/i;

/**
 * Navigate to a route that carries a deliberately invalid id, and assert the
 * app absorbs it in silence.
 *
 * The console listener is attached BEFORE the navigation on purpose: the
 * ticker fires its first managed-settings read on mount, which is where the
 * defect lived, and a listener attached afterwards would miss exactly the one
 * message this spec exists to catch.
 */
async function expectQuietlyHandled(page: Page, path: string): Promise<void> {
  const consoleErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));

  await page.goto(path);
  await page.waitForLoadState('domcontentloaded');
  // Longer than the ticker's first read and any retry behind it.
  await page.waitForTimeout(4000);

  // Mounted, not the catch-all, no error boundary. See ./utils.
  await assertRendered(page, path);

  // A player never reads a SQLSTATE.
  const body = await page.locator('body').innerText();
  expect(body, `${path} showed a database error to the player`).not.toMatch(
    /22P0\d|invalid input syntax/i
  );

  // THE REGRESSION PIN. Narrow, so it can only ever go red for this defect.
  expect(
    consoleErrors.filter((t) => BOUNDARY_ERROR.test(t)),
    `${path} sent an unchecked route segment to a typed column. That is the ` +
      'defect that filed 243 rows into horse_bug_reports. Guard it with ' +
      'isUUID before the query; see tests/a-route-segment-is-not-an-id.law.test.ts'
  ).toEqual([]);

  // AND NOTHING ELSE THE APP ITSELF SAYS. An invalid id is an ordinary thing
  // for a URL to contain and it must cost nothing.
  //
  // One exclusion, and only one: a failed SUBRESOURCE request. The browser
  // reports a 404 image or a blocked third-party beacon as a console error
  // of its own accord, it is not the application reporting anything, and it
  // has nothing to do with how a route handles an id. Everything the app
  // logs itself is still held at zero - including its own reporters, which
  // is the point. Nothing else may be added to this list without a reason
  // written beside it: a gate that quietly grows an allowlist is a gate that
  // stops meaning anything (CLAUDE.md 10.83).
  const SUBRESOURCE = /^Failed to load resource\b|net::ERR_|ERR_BLOCKED_BY_CLIENT/;
  expect(
    consoleErrors.filter((t) => !SUBRESOURCE.test(t)),
    `${path} logged console errors while handling an invalid id. Every one ` +
      'is printed above: either this route started shouting, or something ' +
      'else on the page did. Both are worth knowing.'
  ).toEqual([]);
}

test.describe('Table Gameplay', () => {
  test('should show table page', async ({ page }) => {
    await expectRoute(page, 'table/demo');
  });

  test('an id that is not an id is handled at the boundary, in silence', async ({ page }) => {
    await expectQuietlyHandled(page, 'table/nonexistent-table-id');
  });

  test('the demo table route is equally quiet', async ({ page }) => {
    // 132 of the 243 rows carried the literal "demo". Same defect, same pin.
    await expectQuietlyHandled(page, 'table/demo');
  });
});

test.describe('Table Creation', () => {
  test('should show table creation page', async ({ page }) => {
    await expectRoute(page, 'clubs/demo/create-table');
  });
});

test.describe('Agent Management', () => {
  test('should show agent management page', async ({ page }) => {
    await expectRoute(page, 'clubs/demo/agents');
  });

  test('should show super agent dashboard', async ({ page }) => {
    await expectRoute(page, 'agent-management');
  });
});

test.describe('Settlement', () => {
  test('should show settlement page', async ({ page }) => {
    await expectRoute(page, 'clubs/demo/settlement');
  });
});

test.describe('Club Financials', () => {
  test('should show club financials page', async ({ page }) => {
    await expectRoute(page, 'clubs/demo/financials');
  });
});

test.describe('Club Settings', () => {
  test('should show club settings page', async ({ page }) => {
    await expectRoute(page, 'clubs/demo/settings');
  });
});

test.describe('Cashier', () => {
  test('should show cashier page', async ({ page }) => {
    /* 2026-08-23: 'Table Buy-In' is the CashierPage heading only while
           `action === 'buyin'`. Bare /cashier does not stay put at all — it
           redirects to clubs/<id>/cashier, the club chip desk (Trade / Record /
           Chip Request), which never shows that string. Assert what the route
           actually lands on instead. */
    await expectRoute(page, 'cashier', { expectText: /Cashier/i });
  });
});

test.describe('Bonus', () => {
  test('should show bonus page', async ({ page }) => {
    await expectRoute(page, 'bonuses');
  });
});

test.describe('Report Player Flow', () => {
  test('should show report player page', async ({ page }) => {
    await expectRoute(page, 'report/demo-user');
  });

  test('should show report review page', async ({ page }) => {
    await expectRoute(page, 'clubs/demo/reports');
  });
});
