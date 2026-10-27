import { test, expect, devices, type Page, type Frame } from '@playwright/test';
import { CASH_SPECTATOR_ACTION, CASH_TABLE_CARD_SELECTOR } from './support/cashTableCandidates';
import { prepareCashLobbyActions } from './support/cashLobbyOverlays';
import { observeCashierFailure } from './support/cashierFailureDiagnostics';
import { diamondEntryRead, settleDiamondSpinsOffer } from './support/diamondInvitationOffer';
import {
  restoreLobbyPreference,
  selectLobbyPreference,
  observeLobbyPreferenceProof,
  readLobbyPreferenceOwner,
  lobbyTabLabel,
  type LobbyPreferenceProof,
} from './support/lobbyPreferenceProof';

/**
 * THE THREE THINGS DAN PHOTOGRAPHED, ON THE LIVE LOBBY (2026-09-10).
 *
 * mobile-lobby-chrome.spec.ts builds the lobby from this commit's stylesheets
 * and measures it; that is the pre-merge gate. This file is the other half:
 * the DEPLOYED lobby, signed in, on the phone engine, after the real wallet
 * has published the real count. It exists because the fixture passed on
 * 2026-09-09 while production printed nothing under MY WALLETS - the page
 * reset the count in the same commit the wallet published it, and no fixture
 * of the CSS could see that. A contract about what a player sees has to be
 * read off what a player sees.
 *
 * Signed out this file skips, like every authenticated spec here. It runs on
 * a phone profile in the chromium project: what it reads - the wallet's
 * published text, a sticky offset, a fixed edge - is decided by the app, not
 * the engine, and the engine-specific geometry is already measured on WebKit
 * by mobile-lobby-chrome.spec.ts.
 */
const CLUB_ID = process.env.E2E_CLUB_ID || 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4';

/** The MY WALLETS title's optical centre on the my-wallets-v1 master, as a
 *  percentage of the plate; the count line is centred on it. */
const TITLE_CENTRE_PCT = 54.65;

const preferenceDiagnostics = new WeakMap<Page, Map<Page, LobbyPreferenceProof>>();
const diagnostics = new WeakMap<Page, ReturnType<typeof observeCashierFailure>>();
test.beforeEach(async ({ page }) => {
  diagnostics.set(page, observeCashierFailure(page));
});
test.afterEach(async ({ page }, testInfo) => {
  let index = 0;
  for (const proof of preferenceDiagnostics.get(page)?.values() ?? []) {
    proof.stop();
    await testInfo.attach(`lobby-preference-phases-${index++}.json`, {
      body: Buffer.from(JSON.stringify(proof.snapshot())),
      contentType: 'application/json',
    });
  }
  preferenceDiagnostics.delete(page);
  const observer = diagnostics.get(page);
  if (!observer) return;
  observer.stop();
  if (testInfo.status !== testInfo.expectedStatus) {
    await testInfo.attach('mobile-lobby-network-diagnostics', {
      body: Buffer.from(JSON.stringify(observer.snapshot())),
      contentType: 'application/json',
    });
  }
  diagnostics.delete(page);
});

// Production has no retries. Preserve the first failed action's trace rather
// than relying on on-first-retry, which never records these failures.
test.use({ ...devices['iPhone 13'], trace: 'retain-on-failure' });

async function openLobby(page: Page) {
  // The Diamond Spins offer opens on the answer to this read. Listen before
  // navigating: it leaves as soon as the club resolves.
  const offer = diamondEntryRead(page);
  await page.goto(`clubs/${CLUB_ID}`, {
    waitUntil: 'domcontentloaded',
    timeout: 30_000,
  });
  await page.waitForTimeout(500);
  test.skip(/\/auth(?:\/|$|\?)/.test(page.url()), 'signed out: the club lobby is behind a login');

  // Either optional welcome can cover a later tab action. Use the original
  // public dismissals, including the shared handler for a delayed Diamond offer.
  await prepareCashLobbyActions(page);
  await expect(page.locator('.lobby-wallets-trigger')).toBeVisible({
    timeout: 45_000,
  });
  // Then settle that offer here, through its real Not Now and with its whole
  // budget, before a 5-second assertion or a scroll measurement can meet it
  // (support/diamondInvitationOffer.ts has the four runs it failed).
  await settleDiamondSpinsOffer(page, offer);
}

test.describe('the mobile lobby chrome on production', () => {
  // The 30s default expired after the first successful wallet-count assertion
  // in run 35310320354. Allow the existing bounded navigation/readiness (30s +
  // 45s), greeting (3s + 8s), count (20s), persistence (4s) and geometry phases
  // to finish. No individual readiness deadline or visual assertion is relaxed.
  // These cases share the certificate account: the persistence journey selects
  // PLO/NLH while the scroll journey selects ALL. Keep this group in order so
  // one real preference write cannot replace another case's saved selection.
  // Default mode still executes later cases when an earlier assertion fails.
  test.describe.configure({ mode: 'default', timeout: 120_000 });

  test('the selected game list survives a cold return to the lobby', async ({ page }, testInfo) => {
    const proofs = new Map<Page, LobbyPreferenceProof>();
    preferenceDiagnostics.set(page, proofs);
    let ownerId: string | undefined;
    const proofFor = (document: Page) => {
      const proof = proofs.get(document);
      if (!proof) throw new Error('Lobby preference observer was not installed before navigation');
      return proof;
    };
    const openPreferenceLobby = async (document: Page, phase: string) => {
      const proof = observeLobbyPreferenceProof(document, CLUB_ID);
      proofs.set(document, proof);
      proof.phase(phase);
      await openLobby(document);
      const documentOwner = await readLobbyPreferenceOwner(document);
      if (ownerId && documentOwner !== ownerId) throw new Error('Lobby preference account changed');
      ownerId = documentOwner;
      const saved = await proof.ready(ownerId);
      if (saved) {
        await expect(
          document
            .getByRole('tablist', { name: 'Game Type', exact: true })
            .getByRole('tab', { name: lobbyTabLabel(saved), exact: true })
        ).toHaveAttribute('aria-selected', 'true');
      }
      return ownerId;
    };
    const certificateOwner = await openPreferenceLobby(page, 'original-open');
    const tabs = page.getByRole('tablist', { name: 'Game Type', exact: true });
    const original = (await tabs.getByRole('tab', { selected: true }).textContent())!.trim();
    const target = original === 'PLO' ? 'NLH' : 'PLO';
    let returningPage: Page | undefined;
    let returningReady = false;
    const failures: unknown[] = [];
    let returningDiagnostics: ReturnType<typeof observeCashierFailure> | undefined;
    try {
      proofFor(page).phase('target-save');
      await selectLobbyPreference(page, CLUB_ID, target, certificateOwner, proofFor(page));
      // A new document has no mounted filter state or tab session cache.
      // Reusing the old document raced its legitimate chunk recovery with
      // goto(), which aborted that recovery and the requested navigation.
      returningPage = await page.context().newPage();
      returningDiagnostics = observeCashierFailure(returningPage);
      await openPreferenceLobby(returningPage, 'cold-return');
      returningReady = true;
      await expect(
        returningPage
          .getByRole('tablist', { name: 'Game Type', exact: true })
          .getByRole('tab', { name: target, exact: true })
      ).toHaveAttribute('aria-selected', 'true');
    } catch (error) {
      failures.push(error);
      if (returningDiagnostics)
        await testInfo.attach('cold-return-network-diagnostics', {
          body: Buffer.from(JSON.stringify(returningDiagnostics.snapshot())),
          contentType: 'application/json',
        });
    } finally {
      // This is the isolated certificate account; restore its original view
      // on the ready document before closing it, then independently read it
      // from another document. Only a failed cold open falls back to the old
      // page. Neither a failed journey nor failed restoration is concealed.
      try {
        await restoreLobbyPreference({
          originalPage: page,
          returningPage,
          returningReady,
          clubId: CLUB_ID,
          original,
          ownerId: certificateOwner,
          proofFor,
          verify: async () => {
            const restoredPage = await page.context().newPage();
            try {
              await openPreferenceLobby(restoredPage, 'restored-readback');
              await expect(
                restoredPage
                  .getByRole('tablist', { name: 'Game Type', exact: true })
                  .getByRole('tab', { name: original, exact: true })
              ).toHaveAttribute('aria-selected', 'true');
            } finally {
              await restoredPage.close();
            }
          },
        });
      } catch (cleanupError) {
        failures.push(cleanupError);
        if (returningDiagnostics)
          await testInfo.attach('cold-return-restoration-network-diagnostics', {
            body: Buffer.from(JSON.stringify(returningDiagnostics.snapshot())),
            contentType: 'application/json',
          });
      } finally {
        returningDiagnostics?.stop();
      }
    }
    if (failures.length > 1)
      throw new AggregateError(failures, 'Cold return and preference restoration failed');
    if (failures.length === 1) throw failures[0];
  });

  test('MY WALLETS prints the count, keeps it, centred and unclipped', async ({ page }) => {
    await openLobby(page);
    const small = page.locator('.lobby-wallets-trigger__copy small');

    /* The number the viewer's role decides, in the wallet's own words. Not a
       placeholder, and not the empty bay that a wiped count leaves behind. */
    await expect(small).toHaveText(/^\d+ Balances?$/, { timeout: 20_000 });
    const printed = await small.textContent();

    /* ...and there is still a count once every balance has had time to load.
       The 2026-09-10 defect was a count published and then taken back; a
       single read at the right instant would have passed. The NUMBER may
       legitimately move in that window (the live role arriving adds a row to
       a cached one); the bay going empty may not. */
    await page.waitForTimeout(4_000);
    expect(await small.textContent(), 'the count was taken back after it printed').toMatch(
      /^\d+ Balances?$/
    );

    const m = await page.evaluate((titleCentrePct) => {
      const btn = document.querySelector('.lobby-wallets-trigger')!;
      const el = btn.querySelector('small')!;
      const range = document.createRange();
      range.selectNodeContents(el);
      const b = btn.getBoundingClientRect();
      const z = el.getBoundingClientRect();
      const t = range.getBoundingClientRect();
      return {
        clipped: t.width > z.width + 0.5,
        offCentreByPct: Math.abs(
          ((t.left + t.width / 2 - b.left) / b.width) * 100 - titleCentrePct
        ),
      };
    }, TITLE_CENTRE_PCT);
    expect(m.clipped, `${printed} is clipped at the plate's edge`).toBe(false);
    expect(m.offCentreByPct, `${printed} is off the painted title's centre`).toBeLessThan(1);
  });

  test('Create, Find and Join lead the arena with no Play Poker plate', async ({ page }) => {
    await openLobby(page);
    await page.goto('./', { waitUntil: 'domcontentloaded' });
    const actions = page.getByRole('navigation', { name: 'Poker Arena Actions', exact: true });
    await expect(actions).toBeVisible({ timeout: 45_000 });
    await expect(page.getByRole('button', { name: /^Play Poker In / })).toHaveCount(0);
    await expect(page.getByText('Club Options', { exact: true })).toHaveCount(0);
  });

  test('compact rows open details and filters stay at their original position', async ({
    page,
  }) => {
    await openLobby(page);
    const allGames = page.getByRole('tab', { name: 'ALL', exact: true });
    await allGames.click();
    await expect(allGames).toHaveAttribute('aria-selected', 'true');
    const row = page.getByTestId('lobby-game-row').first();
    await expect(row).toBeVisible({ timeout: 45_000 });
    await expect(page.locator('.compact-lobby')).toBeVisible();
    await expect(page.locator('.ad-rotator--lobby-strip')).toHaveCount(0);
    const rowLayout = await page.locator('.compact-lobby').evaluate((table) => {
      const header = table.querySelector('thead th:nth-child(3)')!;
      const center = (el: Element) => {
        const box = el.getBoundingClientRect();
        return box.left + box.width / 2;
      };
      return {
        players: [...table.querySelectorAll('.lt-seats__num, .lt-seats__tables')].map((el) =>
          Math.abs(center(el) - center(header))
        ),
        detailsWrap: [...table.querySelectorAll('.compact-lobby__meta')].every(
          (el) => getComputedStyle(el).whiteSpace === 'normal'
        ),
      };
    });
    expect(rowLayout.players.length).toBeGreaterThan(0);
    expect(rowLayout.players.every((offset) => offset <= 1)).toBe(true);
    expect(rowLayout.detailsWrap).toBe(true);
    await expect(page.locator('.lobby-refinements')).toBeVisible();
    await expect(page.locator('.lobby-sortbar')).toBeHidden();
    const deck = page.locator('.club-lobby-command-top__controls');
    await expect(deck).toHaveCSS('position', 'relative');
    await page.evaluate(() => window.scrollTo(0, 0));
    const home = await deck.evaluate((el) => el.getBoundingClientRect().top);
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.evaluate(() => window.scrollBy(0, -64));
    await expect
      .poll(() => deck.evaluate((el) => el.getBoundingClientRect().bottom))
      .toBeLessThan(0);
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect
      .poll(() => deck.evaluate((el) => el.getBoundingClientRect().top))
      .toBeCloseTo(home, 0);
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth))
      .toBeLessThanOrEqual(1);
    const cash = page.locator('[data-testid="lobby-game-row"][data-kind="cash"]').first();
    await expect(cash).toBeVisible();
    await cash.getByRole('button', { name: /^Details:/ }).click();
    await expect(page.getByRole('dialog').locator('.arena-game-card')).toBeVisible();
    await page.getByRole('button', { name: 'Close Game Lobby', exact: true }).click();
    await expect(page.getByRole('dialog').locator('.arena-game-card')).toHaveCount(0);
  });

  test('tournament Details stays inside the spectator table lobby tab', async ({
    page,
  }, testInfo) => {
    test.skip(
      !process.env.SP_EMAIL || !process.env.SP_PASS,
      'The embedded lobby journey requires the isolated production certificate account.'
    );
    expect(
      /^ca-customization-cert-.*@example\.invalid$/.test(process.env.SP_EMAIL || ''),
      'This read-only journey may use only the reserved certificate identity'
    ).toBe(true);
    // Use this group's existing 120-second budget: navigation only, with no
    // additional natural-hand observation or participation phase.
    const participation: string[] = [];
    const routeTrace: string[] = [];
    let tableUrl = '';
    let tournamentId: string | null = null;
    const forbidden =
      /\/(?:action|leave|post-bb|rabbit-hunt|rest\/v1\/(?:table_seats|tournament_players|wallet_transactions|rpc\/(?:fn_cash_game_join|atomic_table_buyin|fn_lightning_join|fn_lightning_buy_in|fn_take_seat_and_buy_in|fn_register_for_tournament|fn_unregister_from_tournament|fn_leave_seat_and_refund|atomic_table_rebuy|process_tournament_rebuy|fn_join_waitlist)))(?:[/?#]|$)/;
    // Refuse an unintended participation request before it can move a seat or
    // chips. The assertion below makes every attempted write a failure.
    await page.route(forbidden, async (route) => {
      const request = route.request();
      if (['GET', 'HEAD', 'OPTIONS'].includes(request.method())) return route.continue();
      participation.push(`${request.method()} ${new URL(request.url()).pathname}`);
      await route.abort('blockedbyclient');
    });
    const observeRoute = (frame: Frame) => {
      if (frame === page.mainFrame()) routeTrace.push(frame.url());
    };
    try {
      await openLobby(page);
      await page.getByRole('tab', { name: 'ALL', exact: true }).click();
      const cash = page.locator(`${CASH_TABLE_CARD_SELECTOR}:visible`).first();
      await expect(cash, 'the certificate club has a live cash game to view').toBeVisible({
        timeout: 20_000,
      });
      await cash.getByRole('button', { name: /^Details:/ }).click();
      const panel = page.getByRole('dialog').filter({ has: page.locator('.arena-game-card') });
      await expect(panel).toHaveCount(1);
      // View is observation. Never press Join, a seat, a registration control,
      // or a quick-join game tile anywhere in this journey.
      await panel.getByRole('button', { name: CASH_SPECTATOR_ACTION }).click();
      await expect(page).toHaveURL(/\/table\/[0-9a-f-]{36}(?:[?#]|$)/i, { timeout: 20_000 });
      const actionBar = page.locator('.table-tab-bar:visible').first();
      await expect(actionBar).toBeVisible({ timeout: 20_000 });
      await actionBar.getByRole('button', { name: 'Open Another Table', exact: true }).click();
      await page
        .getByRole('dialog', { name: 'Quick Join', exact: true })
        .getByRole('button', { name: 'Browse Full Lobby', exact: true })
        .click();
      const lobby = page.locator('.multi-table-page__lobby-tab .club-home:visible');
      await expect(lobby).toBeVisible({ timeout: 30_000 });
      await lobby.getByRole('tab', { name: 'MTT', exact: true }).click();
      const tournament = lobby
        .locator('[data-testid="lobby-game-row"][data-kind="mtt"]:visible')
        .first();
      await expect(tournament, 'the certificate club lists a tournament to read').toBeVisible({
        timeout: 20_000,
      });
      tournamentId = await tournament.getAttribute('data-id');
      expect(tournamentId).toMatch(/^[0-9a-f-]{36}$/i);
      await tournament.getByRole('button', { name: /^Details:/ }).click();
      await expect(panel).toHaveCount(1);
      tableUrl = page.url();
      expect(new URL(tableUrl).pathname).toMatch(/\/table\/[0-9a-f-]{36}$/i);
      // The app can recover a wrong /tournaments route through its backstop.
      // Observe every native same-document navigation so a final restored URL
      // cannot hide the route departure this source repair prevents.
      routeTrace.push(tableUrl);
      page.on('framenavigated', observeRoute);
      await panel.getByRole('button', { name: 'Details', exact: true }).click();
      await expect(page.locator('.tournament-details[data-lobby-tab="true"]:visible')).toBeVisible({
        timeout: 20_000,
      });
      await expect(actionBar).toBeVisible();
      expect(page.url()).toBe(tableUrl);
      expect(
        routeTrace.every((url) => url === tableUrl),
        'Details left the running table route'
      ).toBe(true);
      expect(participation, 'spectator navigation attempted participation').toEqual([]);
    } finally {
      page.off('framenavigated', observeRoute);
      await testInfo.attach('embedded-tournament-details-route.json', {
        body: Buffer.from(JSON.stringify({ tableUrl, tournamentId, routeTrace, participation })),
        contentType: 'application/json',
      });
      // Keep the participation refusal installed through page teardown.
    }
  });

  test('the footer frame sits on the bottom edge with nothing under it', async ({ page }) => {
    await openLobby(page);
    /* Two landmarks share this name on a club lobby: the arena boundary's
       "Choose Arena" nav inside the page, and the footer. The footer is the
       one that carries the role-scoped controls. */
    const nav = page
      .getByRole('navigation', { name: 'Poker Arena' })
      .filter({ has: page.locator('[data-footer-control]') });
    await expect(nav).toHaveCount(1);
    await expect(nav).toBeVisible();
    await expect(nav).toHaveCSS('position', 'fixed');
    // Resolve the approved role-specific artwork before measuring. The live
    // list can reflow between Playwright calls, so visibility, the actual end
    // and painted-frame geometry must be read together in one browser turn.
    const doors = nav.locator('[data-footer-doors]');
    await expect(doors).toHaveCount(1);
    await expect(doors).toHaveAttribute('data-footer-doors', /^(member|operator)$/);
    const kind = await doors.getAttribute('data-footer-doors');
    const baseFrame =
      kind === 'member' ? 'club-arena-footer-player-v2.webp' : 'club-arena-footer-v4.webp';
    const artwork = doors.locator('..');
    await expect(artwork).toHaveCount(1);
    await expect(artwork.locator(`picture > img[src$="/${baseFrame}"]`)).toHaveCount(1);
    await expect
      .poll(
        () =>
          nav.evaluate((bar) => {
            const root = document.documentElement;
            window.scrollTo(0, root.scrollHeight);
            const atEnd = window.scrollY >= root.scrollHeight - window.innerHeight - 1;
            const shown = bar.getAttribute('data-footer-hidden') === 'false';
            const frame = bar.querySelector('[data-footer-doors]')?.parentElement;
            if (!atEnd || !shown || !frame) return Number.POSITIVE_INFINITY;
            const probe = document.createElement('div');
            probe.style.cssText =
              'position:fixed;bottom:0;left:0;width:1px;height:1px;pointer-events:none';
            document.body.appendChild(probe);
            const edge = probe.getBoundingClientRect().bottom;
            const painted = frame.getBoundingClientRect();
            probe.remove();
            return Math.abs(painted.bottom - edge);
          }),
        {
          message:
            'visible painted footer frame touches the bottom edge at the actual end of the lobby',
          timeout: 10_000,
          intervals: [300, 300, 500, 1_000],
        }
      )
      .toBeLessThan(1);
  });
});
