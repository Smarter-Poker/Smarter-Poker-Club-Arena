/**
 * TABLE MANAGEMENT, ON THE LIVE SITE.
 *
 * The section redesign (each surface its own composition on its own approved
 * frame family) was proved on a render harness and in the served bundle, and
 * then nothing watched it. A harness proves the code draws; only production
 * proves the operator sees it. This is the missing layer, and it is the layer
 * that keeps paying: the day a frame family, the section strip or a plate
 * label is lost to a merge, this says so on the next deploy instead of Dan
 * saying it a week later.
 *
 * READ-ONLY. It signs in through the suite's own globalSetup, navigates, and
 * reads. It saves nothing, publishes nothing and closes nothing: no Save, no
 * plate, no row action is ever clicked.
 *
 * ── WHY TWO CLUBS, AND WHY NOTHING HERE SKIPS (2026-09-29) ──────────────────
 *
 * The first version of this file pointed every test at E2E_CLUB_ID and let a
 * refusal skip. On the 2026-09-29 deploy that is exactly what happened: four
 * of five tests skipped or failed and the frames were never certified live,
 * because E2E_CLUB_ID (SHARK CLUB) belongs to a union, and a union's member
 * club correctly refuses local game management - "This Club Is Managed By Its
 * Union". The board can never render there, so a suite aimed at it can only
 * ever report nothing.
 *
 * The post-deploy job already provisions the reserved account as an admin of
 * BOTH clubs (production-e2e-account.mjs: prepare-staff and
 * prepare-template-staff). So:
 *
 *   STANDALONE_CLUB  (E2E_TEMPLATE_CLUB_ID) owns its own games. The board,
 *                    the ticker, club messages and the Add Table picker are
 *                    certified here, and a refusal here is a FAILURE, not a
 *                    skip: it means the fixture drifted and this layer has
 *                    gone blind again.
 *   UNION_MEMBER_CLUB (E2E_CLUB_ID) is the refusal. That is a shipped surface
 *                    too and it gets its own certificate: the shark frame,
 *                    one Return plate, and no section strip.
 *
 * Signed out is the one honest skip: globalSetup can fail to get a session.
 */
import { expect, test, type Page } from '@playwright/test';
import { observeCashierFailure } from './support/cashierFailureDiagnostics';

/** The standalone reserved club: its own games, so its own board. */
const STANDALONE_CLUB = process.env.E2E_TEMPLATE_CLUB_ID || '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3';
/** The reserved club that belongs to a union: management is refused there. */
const UNION_MEMBER_CLUB = process.env.E2E_CLUB_ID || 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4';

const BOARD = `clubs/${STANDALONE_CLUB}/table-management`;
const ROUTE_NAVIGATION_TIMEOUT_MS = 30_000;
const ROUTE_OUTCOME_TIMEOUT_MS = 45_000;
const MOBILE_SURFACE_COUNT = 9;
const MOBILE_SWEEP_TIMEOUT_MS =
  MOBILE_SURFACE_COUNT * (ROUTE_NAVIGATION_TIMEOUT_MS + ROUTE_OUTCOME_TIMEOUT_MS) + 15_000;

/** Every painted frame on the page: SpadeConsole's root always carries `sc`. */
const FRAMES = '.sc';

// Preserve bounded network evidence on failure without changing live requests.
const diagnostics = new WeakMap<Page, ReturnType<typeof observeCashierFailure>>();
test.beforeEach(async ({ page }) => {
  diagnostics.set(page, observeCashierFailure(page));
});
test.afterEach(async ({ page }, testInfo) => {
  const observer = diagnostics.get(page);
  if (!observer) return;
  observer.stop();
  if (testInfo.status !== testInfo.expectedStatus) {
    await testInfo.attach('table-management-network-diagnostics', {
      body: Buffer.from(JSON.stringify(observer.snapshot())),
      contentType: 'application/json',
    });
  }
  diagnostics.delete(page);
});

type Outcome = 'board' | 'refused';

const strip = (page: Page) => page.getByRole('navigation', { name: 'Management Sections' });
const returnPlate = (page: Page) => page.getByRole('button', { name: 'Return' });

/**
 * Navigate, then wait for the page to reach one of its two real outcomes.
 *
 * The previous helper slept 1200ms and then waited for the access-check copy
 * to DETACH. On a cold first load that copy has not rendered yet, so
 * "detached" was already true the moment it was asked: the refusal probe read
 * a still-empty page, reported "not refused", and the test then spent its
 * whole 30s budget waiting for a section strip on a page that had already
 * resolved to Locked. Never time a wait against a clock when the outcome
 * itself is observable.
 */
async function open(page: Page, path: string): Promise<Outcome> {
  await page.goto(path, { waitUntil: 'domcontentloaded', timeout: ROUTE_NAVIGATION_TIMEOUT_MS });
  test.skip(/\/auth(?:\/|$|\?)/.test(page.url()), 'signed out: Table Management is behind a login');

  const deadline = Date.now() + ROUTE_OUTCOME_TIMEOUT_MS;
  for (;;) {
    if ((await strip(page).count()) > 0) return 'board';
    if ((await returnPlate(page).count()) > 0) return 'refused';
    if (Date.now() > deadline) {
      throw new Error(
        `${path} never resolved to the board or to the refusal within 45s ` +
          `(still on the access check, or drawing neither surface)`
      );
    }
    await page.waitForTimeout(250);
  }
}

async function frameFamilies(page: Page) {
  return page.$$eval(FRAMES, (frames) =>
    frames.map((frame) =>
      Array.from(frame.classList).find((name) => name.startsWith('sc--family-'))
    )
  );
}

async function expectNoHorizontalOverflow(page: Page, path: string) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow, `${path} scrolls sideways by ${overflow}px`).toBeLessThanOrEqual(1);
}

/** A refusal on the standalone club is fixture drift, and it is fatal here:
 *  a silent skip is how this layer went blind on 2026-09-29. */
function mustSeeBoard(outcome: Outcome, path: string) {
  expect(
    outcome,
    `${path} refused game management on the standalone reserved club ` +
      `(${STANDALONE_CLUB}). The post-deploy job's prepare-template-staff step ` +
      `makes the reserved account an admin there, so a refusal means the club ` +
      `joined a union or the membership was not provisioned - fix the fixture, ` +
      `do not skip this certificate.`
  ).toBe('board');
}

/** Certify the creator's composition without submitting, saving or mutating it. */
async function expectRivetedCreator(page: Page, path: string, pill: string) {
  mustSeeBoard(await open(page, path), path);

  const dialog = page.getByRole('dialog', { name: 'Create Game' });
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  const frames = dialog.locator(FRAMES);
  await expect(frames).toHaveCount(1);
  await expect(frames).toHaveClass(/sc--family-riveted/);
  await expect(dialog.getByText(pill, { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Create Tournament' })).toBeVisible();
}

test.describe('Table Management is its own page on its own frame, in production', () => {
  test('the board draws one frame, with the section strip outside it', async ({ page }) => {
    mustSeeBoard(await open(page, BOARD), BOARD);

    // The strip is navigation, not a display window: it is never inside a frame.
    await expect(strip(page)).toBeVisible();
    expect(await strip(page).evaluate((node) => Boolean(node.closest('.sc')))).toBe(false);

    expect(await frameFamilies(page)).toEqual(['sc--family-spade']);
    await expect(page.getByRole('heading', { name: 'Table Management' })).toBeVisible();
    // The other two sections are not printed in this window.
    expect(await page.getByRole('heading', { name: 'Ticker Management' }).count()).toBe(0);
    expect(await page.getByRole('heading', { name: 'Club Messages' }).count()).toBe(0);
  });

  test('the ticker is the shark frame with its one plate', async ({ page }) => {
    const path = `${BOARD}?section=ticker`;
    mustSeeBoard(await open(page, path), path);

    await expect(page.getByRole('heading', { name: 'Ticker Management' })).toBeVisible({
      timeout: 30_000,
    });
    expect(await frameFamilies(page)).toEqual(['sc--family-shark']);
    await expect(page.getByRole('button', { name: 'Save Ticker' })).toBeVisible();
    expect(await page.getByRole('heading', { name: 'Table Management' }).count()).toBe(0);
  });

  test('club messages is the riveted frame with its two plates', async ({ page }) => {
    const path = `${BOARD}?section=messages`;
    mustSeeBoard(await open(page, path), path);

    await expect(page.getByRole('heading', { name: 'Club Messages' })).toBeVisible({
      timeout: 30_000,
    });
    expect(await frameFamilies(page)).toEqual(['sc--family-riveted']);
    await expect(page.getByRole('button', { name: 'Save Identity' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Publish Banner' })).toBeVisible();

    // The two switches wear the kit's tick well, not the text-field groove:
    // this is what shipped broken on 2026-09-29 and it is pinned here in the
    // one place that sees the real stylesheet.
    const box = page.locator('.sc-check__box').first();
    await expect(box).toBeVisible();
    const size = await box.boundingBox();
    expect(size).not.toBeNull();
    expect(size!.width).toBeLessThan(60);
    expect(Math.abs(size!.width - size!.height)).toBeLessThan(4);
  });

  test('the Add Table picker draws no frame around the painted cards', async ({ page }) => {
    const path = `${BOARD}?create=table`;
    mustSeeBoard(await open(page, path), path);

    await expect(page.getByRole('heading', { name: 'Choose Game Type' })).toBeVisible({
      timeout: 30_000,
    });
    expect(await frameFamilies(page)).toEqual([]);
    await expect(page.getByRole('button', { name: 'Back To Table Management' })).toBeVisible();
  });

  test('Table Config replaces the board with its own spade creator frame', async ({ page }) => {
    const path = `${BOARD}?create=table&game=nlh`;
    mustSeeBoard(await open(page, path), path);

    await expect(page.getByRole('heading', { name: 'NLH Setup' })).toBeVisible({
      timeout: 30_000,
    });
    expect(await frameFamilies(page)).toEqual(['sc--family-spade']);
    await expect(page.getByRole('button', { name: 'Back To Game Types' })).toBeVisible();
    expect(await page.getByRole('heading', { name: 'Table Management' }).count()).toBe(0);
  });

  test('the Event creator is its own riveted dialog and stays read-only', async ({ page }) => {
    await expectRivetedCreator(page, `${BOARD}?create=event`, 'Event');
  });

  test('the Spins creator is its own riveted dialog and stays read-only', async ({ page }) => {
    await expectRivetedCreator(page, `${BOARD}?create=spin`, 'Spins');
  });

  test('the Sit N Go creator is its own riveted dialog and stays read-only', async ({ page }) => {
    await expectRivetedCreator(page, `${BOARD}?create=sng`, 'Sit N Go');
  });

  test('a union member club is refused on the shark frame, with no section strip', async ({
    page,
  }) => {
    const path = `clubs/${UNION_MEMBER_CLUB}/table-management`;
    const outcome = await open(page, path);
    expect(
      outcome,
      `${path} drew the board. The reserved club ${UNION_MEMBER_CLUB} belongs to a ` +
        `union, and a union's member club does not manage its own games - if this ` +
        `now renders, either the club left its union or the gate was weakened.`
    ).toBe('refused');

    expect(await frameFamilies(page)).toEqual(['sc--family-shark']);
    expect(await returnPlate(page).count()).toBe(1);
    // A refusal is one window. It is not the board with a notice on it.
    expect(await strip(page).count()).toBe(0);
    await expect(page.getByText('Game Management Is Restricted')).toBeVisible();
  });

  test('no surface scrolls sideways on a phone', async ({ page }) => {
    // This one case visits nine production surfaces. Its outer budget must not
    // undercut the explicit navigation plus outcome allowance of any surface.
    test.setTimeout(MOBILE_SWEEP_TIMEOUT_MS);
    await page.setViewportSize({ width: 393, height: 852 });

    for (const [path, family] of [
      [BOARD, 'sc--family-spade'],
      [`${BOARD}?section=ticker`, 'sc--family-shark'],
      [`${BOARD}?section=messages`, 'sc--family-riveted'],
    ] as const) {
      mustSeeBoard(await open(page, path), path);
      expect(await frameFamilies(page)).toEqual([family]);
      await expectNoHorizontalOverflow(page, path);
    }

    const pickerPath = `${BOARD}?create=table`;
    mustSeeBoard(await open(page, pickerPath), pickerPath);
    await expect(page.getByRole('heading', { name: 'Choose Game Type' })).toBeVisible();
    expect(await frameFamilies(page)).toEqual([]);
    await expectNoHorizontalOverflow(page, pickerPath);

    const configPath = `${BOARD}?create=table&game=nlh`;
    mustSeeBoard(await open(page, configPath), configPath);
    await expect(page.getByRole('heading', { name: 'NLH Setup' })).toBeVisible();
    expect(await frameFamilies(page)).toEqual(['sc--family-spade']);
    await expectNoHorizontalOverflow(page, configPath);

    for (const [path, pill] of [
      [`${BOARD}?create=event`, 'Event'],
      [`${BOARD}?create=spin`, 'Spins'],
      [`${BOARD}?create=sng`, 'Sit N Go'],
    ] as const) {
      await expectRivetedCreator(page, path, pill);
      await expectNoHorizontalOverflow(page, path);
    }

    const refusalPath = `clubs/${UNION_MEMBER_CLUB}/table-management`;
    expect(await open(page, refusalPath)).toBe('refused');
    expect(await frameFamilies(page)).toEqual(['sc--family-shark']);
    await expect(page.getByText('Game Management Is Restricted')).toBeVisible();
    await expectNoHorizontalOverflow(page, refusalPath);
  });
});
