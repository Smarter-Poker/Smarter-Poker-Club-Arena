import { test, expect, devices, type Page } from '@playwright/test';
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

test.use({ ...devices['iPhone 13'] });

async function openLobby(page: Page) {
  // The Diamond Spins offer opens on the answer to this read. Listen before
  // navigating: it leaves as soon as the club resolves.
  const offer = diamondEntryRead(page);
  await page.goto(`clubs/${CLUB_ID}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForTimeout(500);
  test.skip(/\/auth(?:\/|$|\?)/.test(page.url()), 'signed out: the club lobby is behind a login');

  // Either optional welcome can cover a later tab action. Use the original
  // public dismissals, including the shared handler for a delayed Diamond offer.
  await prepareCashLobbyActions(page);
  await expect(page.locator('.lobby-wallets-trigger')).toBeVisible({ timeout: 45_000 });
  // Then settle that offer here, through its real Not Now and with its whole
  // budget, before a 5-second assertion or a scroll measurement can meet it
  // (support/diamondInvitationOffer.ts has the four runs it failed).
  await settleDiamondSpinsOffer(page, offer);
}

/** Where a fixed element at bottom: 0 lands is the bottom edge. The viewport
 *  height is not: WebKit's mobile emulation reports it taller than the layout
 *  viewport fixed elements attach to. */
async function bottomEdge(page: Page) {
  return page.evaluate(() => {
    const probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;bottom:0;left:0;width:1px;height:1px;pointer-events:none';
    document.body.appendChild(probe);
    const edge = probe.getBoundingClientRect().bottom;
    probe.remove();
    return edge;
  });
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
          onFailure: async (document) => {
            await testInfo.attach('cold-return-restoration-page', {
              body: await document.screenshot({ timeout: 3_000 }),
              contentType: 'image/png',
            });
          },
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

  test('the filter row locks under Find Your Game when the lobby scrolls', async ({ page }) => {
    await openLobby(page);
    // The remembered MTT tab can legitimately be empty. Select the populated
    // aggregate through the same UI a player uses before measuring its sort row.
    const allGames = page.getByRole('tab', { name: 'ALL', exact: true });
    await allGames.click();
    await expect(allGames).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('arena-lobby-game-card').first()).toBeVisible({
      timeout: 45_000,
    });
    const sortbar = page.locator('.lobby-sortbar');
    await expect(sortbar).toBeVisible({ timeout: 45_000 });
    await expect(sortbar).toHaveCSS('position', 'sticky');

    /* Scroll far enough that an unstuck row would leave the screen. */
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(600);
    const m = await page.evaluate(() => {
      const row = document.querySelector('.lobby-sortbar')!.getBoundingClientRect();
      const deck = document
        .querySelector('.club-lobby-command-top__controls')!
        .getBoundingClientRect();
      return {
        rowTop: row.top,
        rowBottom: row.bottom,
        deckBottom: deck.bottom,
        scrolled: window.scrollY,
      };
    });
    expect(m.scrolled, 'the lobby did not scroll at all').toBeGreaterThan(0);
    expect(m.rowBottom, 'the filter row scrolled off the top of the page').toBeGreaterThan(0);
    expect(
      Math.abs(m.rowTop - m.deckBottom),
      'gap between Find Your Game and the row'
    ).toBeLessThan(1);
  });

  test('the footer frame sits on the bottom edge with nothing under it', async ({ page }) => {
    await openLobby(page);
    /* Two landmarks share this name on a club lobby: the arena boundary's
       "Choose Arena" nav inside the page, and the footer. The footer is the
       one that carries the six controls. */
    const nav = page
      .getByRole('navigation', { name: 'Poker Arena' })
      .filter({ has: page.locator('[data-footer-control]') });
    await expect(nav).toHaveCount(1);
    await expect(nav).toBeVisible();
    await expect(nav).toHaveCSS('position', 'fixed');
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(300);

    const edge = await bottomEdge(page);
    // The Diamond Spins overlay is a second image; measure the approved base frame.
    const artwork = nav.locator('img[src$="/club-arena-footer-v3.webp"]').locator('..');
    await expect(artwork).toHaveCount(1);
    const frame = await artwork.boundingBox();
    expect(frame).not.toBeNull();
    expect(
      Math.abs(frame!.y + frame!.height - edge),
      'strip between the painted frame and the bottom edge'
    ).toBeLessThan(1);
  });
});
