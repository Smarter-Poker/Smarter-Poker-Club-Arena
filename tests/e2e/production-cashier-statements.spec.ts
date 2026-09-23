/**
 * CASHIER STATEMENTS E2E (Cashier Phase 5) - assertions that cannot pass
 * without the Full Statement.
 *
 * Route `clubs/:clubId/cashier/statements` (src/pages/CashierStatementsPage.tsx)
 * sits behind the same AuthGuard and ClubMemberGuard as the Cashier itself, and
 * what it may show is decided by `fn_cashier_statement_page` on the server: the
 * RPC's `authorized` flag, never the client, says whether the viewer gets a
 * statement or the refusal copy. This suite therefore observes that RPC on the
 * wire and asserts whichever branch the server took - never both.
 *
 * Read-only by construction. The Export word is looked at and never clicked,
 * and the spec fails if any export RPC leaves the page.
 */

import { expect, test } from '@playwright/test';

const CLUB_ID = process.env.E2E_CLUB_ID || 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4';
const HAS_AUTH = Boolean(process.env.SP_EMAIL && process.env.SP_PASS);

const PAGE_RPC = '/rest/v1/rpc/fn_cashier_statement_page';
const TOTALS_RPC = '/rest/v1/rpc/fn_cashier_statement_totals';
const EXPORT_RPC = /^\/rest\/v1\/rpc\/fn_cashier_statement_export_(?:start|page|cancel)$/;

/**
 * A figure on the glass, as CashierStatementsPage's chips() prints it: whole
 * chips grouped by thousands, a leading sign only on a non-zero In or Out, and
 * cents only when the ledger really holds them. The Entries cell is a plain
 * en-US integer, which the same shape accepts.
 */
const FIGURE = /^[+-]?\d{1,3}(?:,\d{3})*(?:\.\d{2,})?$/;

test.describe('Cashier Statements - authenticated production route', () => {
  test.describe.configure({ timeout: 90_000 });
  test.skip(
    !HAS_AUTH,
    'SP_EMAIL/SP_PASS are required; a signed-out page is not a Full Statement proof.'
  );

  test('serves the Full Statement console and honors the server authorization verdict', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const consoleErrors: Array<{ text: string; url: string }> = [];
    page.on('console', (message) => {
      if (message.type() === 'error') {
        consoleErrors.push({ text: message.text(), url: message.location().url });
      }
    });
    const exportCalls: string[] = [];
    page.on('request', (request) => {
      if (EXPORT_RPC.test(new URL(request.url()).pathname)) exportCalls.push(request.url());
    });

    // Listen before navigating: the first page RPC leaves as soon as the club
    // id resolves, and a listener attached afterwards can only miss it.
    const pageRpc = page.waitForResponse(
      (response) => new URL(response.url()).pathname === PAGE_RPC,
      { timeout: 60_000 }
    );
    const totalsRpc = page
      .waitForResponse((response) => new URL(response.url()).pathname === TOTALS_RPC, {
        timeout: 60_000,
      })
      .catch(() => null);

    // (a) The signed-in visit lands on the route itself, not on auth.
    await page.goto(`clubs/${CLUB_ID}/cashier/statements`, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    await expect(page).not.toHaveURL(/\/auth(?:\/|\?|$)/, { timeout: 30_000 });
    await expect(page).toHaveURL(new RegExp(`/clubs/${CLUB_ID}/cashier/statements(?:[/?#]|$)`), {
      timeout: 30_000,
    });

    // (b) Exactly one SpadeConsole chassis carries the page.
    const surface = page.locator('[data-cashier-surface="statements"]');
    await expect(surface).toBeVisible({ timeout: 60_000 });
    await expect(surface.locator('.sc')).toHaveCount(1);
    await expect(surface.locator('.sc__eyebrow')).toHaveText('Full Statement');
    await expect(surface.locator('.sc__title')).toHaveText('Cashier');
    await expect(
      surface.getByRole('button', { name: 'Back To Cashier', exact: true })
    ).toBeVisible();

    // (c) The page RPC answers 200 and its `authorized` flag decides the branch.
    const response = await pageRpc;
    expect(response.status(), `${PAGE_RPC} did not answer 200`).toBe(200);
    const body = (await response.json()) as { authorized?: unknown; scope?: unknown };
    expect(typeof body.authorized, 'fn_cashier_statement_page returned no boolean authorized').toBe(
      'boolean'
    );
    const authorized = body.authorized === true && body.scope !== 'none';

    const pill = surface.locator('.sc__pill');
    const totals = surface.locator('[aria-label="Statement Totals"]');
    const exportSection = surface.locator('section[aria-labelledby="statement-export-title"]');
    const exportWord = exportSection.getByRole('button', { name: 'Export CSV', exact: true });

    if (authorized) {
      const access = surface.locator('section[aria-label="What You Can See"]').getByRole('status');
      await expect(access).toHaveText(
        /^(Every Entry In This Club|Your Entries And Your Downline|Your Own Entries)$/,
        { timeout: 30_000 }
      );

      // The entries list settles on rows or on the truthful empty state. An
      // error here would contradict the 200 just observed, so it fails.
      const entries = surface.locator('section[aria-labelledby="statement-entries-title"]');
      await expect(entries.getByRole('heading', { name: 'Entries', exact: true })).toBeVisible();
      const rows = entries.locator('button[aria-expanded]');
      const empty = entries.getByText('No Entries In This Range.', { exact: true });
      await expect
        .poll(async () => (await rows.count()) + (await empty.count()), {
          timeout: 30_000,
          message: 'Entries never reached rows or the empty state',
        })
        .toBeGreaterThan(0);
      await expect(entries.getByRole('alert')).toHaveCount(0);
      await expect(entries.getByText('Loading Statement...', { exact: true })).toHaveCount(0);

      // (d) Totals reach a terminal state once their RPC has settled: four
      // figures, or the Unavailable word. Never Calculating.
      await totalsRpc;
      const totalsWord = totals.getByRole('status');
      await expect
        .poll(
          async () => {
            const word =
              (await totalsWord.count()) > 0 ? (await totalsWord.innerText()).trim() : '';
            if (word === 'Unavailable For This Range') return 'unavailable';
            if (word === 'Calculating') return 'calculating';
            const figures = (await totals.locator('strong').allInnerTexts()).map((f) => f.trim());
            return figures.length === 4 && figures.every((figure) => FIGURE.test(figure))
              ? 'figures'
              : `pending:${figures.join('|')}`;
          },
          { timeout: 30_000, message: 'Statement Totals never reached a terminal state' }
        )
        .toMatch(/^(figures|unavailable)$/);
      await expect(totals).not.toContainText('Calculating');
      // The pill zone's textContent ends on a deliberate word-boundary space
      // (SpadeConsole ZoneText, 2026-09-23); a regex toHaveText does not
      // normalise it, so the anchor tolerates trailing whitespace.
      await expect(pill).toHaveText(/^(?:\d+(?:\.\d)?[KMB]? (?:Entry|Entries)|Live Ledger)\s*$/);

      // (e) The Export word is present. It is enabled exactly when the range
      // holds entries (the page disables it on an empty range), and it is
      // never clicked here: no export RPC may leave this page.
      await expect(
        exportSection.getByRole('heading', { name: 'Export', exact: true })
      ).toBeVisible();
      await expect(exportWord).toBeVisible();
      await expect(exportSection.getByRole('status')).toHaveText(
        /^Exports The Whole Range As A CSV File, Up To [\d,]+ Entries\.$/
      );
      if ((await rows.count()) > 0) {
        await expect(exportWord).toBeEnabled({ timeout: 30_000 });
      } else {
        await expect(exportWord).toBeDisabled();
      }
    } else {
      // The server refused: the page shows only its refusal copy, no statement.
      const refusal = surface.getByRole('alert');
      await expect(refusal).toBeVisible({ timeout: 30_000 });
      await expect(
        refusal.getByRole('heading', { name: 'Statement Unavailable', exact: true })
      ).toBeVisible();
      await expect(
        refusal.getByText('Your Role In This Club Does Not Include This Statement.', {
          exact: true,
        })
      ).toBeVisible();
      await expect(pill).toHaveText('Refused');
      await expect(totals).toHaveCount(0);
      await expect(exportWord).toHaveCount(0);
    }

    expect(exportCalls, 'an export RPC left the page without a click').toEqual([]);

    // (f) No error boundary and no console error of the app's own kind.
    await expect(page.getByText('Something went wrong', { exact: false })).toHaveCount(0);
    const critical = consoleErrors.filter(
      (entry) =>
        !entry.text.includes('[cashier-telemetry]') &&
        !entry.text.includes('favicon') &&
        !entry.url.includes('favicon')
    );
    expect(critical, critical.map((entry) => `${entry.url}: ${entry.text}`).join('\n')).toEqual([]);
  });
});
