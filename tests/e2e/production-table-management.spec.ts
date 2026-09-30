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
 * Signed out, or without management authority on the fixture club, it skips
 * the parts it cannot see and still certifies what it can - a refusal is a
 * shipped surface too, and it wears the shark frame with its one Return plate.
 */
import { expect, test, type Page } from '@playwright/test';

/** The reserved production E2E club (production-e2e-account.mjs). */
const CLUB_ID = process.env.E2E_CLUB_ID || 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4';
const BOARD = `clubs/${CLUB_ID}/table-management`;

/** Every painted frame on the page: SpadeConsole's root always carries `sc`. */
const FRAMES = '.sc';

async function open(page: Page, path: string) {
  await page.goto(path, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForTimeout(1200);
  test.skip(/\/auth(?:\/|$|\?)/.test(page.url()), 'signed out: Table Management is behind a login');
  // The access check draws its own console while it runs; wait it out.
  await page
    .getByText('Verifying Game-Management Access', { exact: false })
    .waitFor({ state: 'detached', timeout: 30_000 })
    .catch(() => {});
}

async function frameFamilies(page: Page) {
  return page.$$eval(FRAMES, (frames) =>
    frames.map((frame) =>
      Array.from(frame.classList).find((name) => name.startsWith('sc--family-'))
    )
  );
}

async function refused(page: Page) {
  return (await page.getByRole('button', { name: 'Return' }).count()) > 0;
}

test.describe('Table Management is its own page on its own frame, in production', () => {
  test('the board draws one frame, with the section strip outside it', async ({ page }) => {
    await open(page, BOARD);

    // The strip is navigation, not a display window: it is never inside a frame.
    const strip = page.getByRole('navigation', { name: 'Management Sections' });
    if (await refused(page)) {
      const families = await frameFamilies(page);
      expect(families).toEqual(['sc--family-shark']);
      expect(await page.getByRole('button', { name: 'Return' }).count()).toBe(1);
      test.info().annotations.push({
        type: 'note',
        description: 'no management authority on the fixture club: certified the refusal surface',
      });
      return;
    }

    await expect(strip).toBeVisible({ timeout: 30_000 });
    expect(await strip.evaluate((node) => Boolean(node.closest('.sc')))).toBe(false);

    const families = await frameFamilies(page);
    expect(families).toEqual(['sc--family-spade']);
    await expect(page.getByRole('heading', { name: 'Table Management' })).toBeVisible();
    // The other two sections are not printed in this window.
    expect(await page.getByRole('heading', { name: 'Ticker Management' }).count()).toBe(0);
    expect(await page.getByRole('heading', { name: 'Club Messages' }).count()).toBe(0);
  });

  test('the ticker is the shark frame with its one plate', async ({ page }) => {
    await open(page, `${BOARD}?section=ticker`);
    test.skip(await refused(page), 'no management authority on the fixture club');

    await expect(page.getByRole('heading', { name: 'Ticker Management' })).toBeVisible({
      timeout: 30_000,
    });
    expect(await frameFamilies(page)).toEqual(['sc--family-shark']);
    await expect(page.getByRole('button', { name: 'Save Ticker' })).toBeVisible();
    expect(await page.getByRole('heading', { name: 'Table Management' }).count()).toBe(0);
  });

  test('club messages is the riveted frame with its two plates', async ({ page }) => {
    await open(page, `${BOARD}?section=messages`);
    test.skip(await refused(page), 'no management authority on the fixture club');

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
    await open(page, `${BOARD}?create=table`);
    test.skip(await refused(page), 'no management authority on the fixture club');

    await expect(page.getByRole('heading', { name: 'Choose Game Type' })).toBeVisible({
      timeout: 30_000,
    });
    expect(await frameFamilies(page)).toEqual([]);
    await expect(page.getByRole('button', { name: 'Back To Table Management' })).toBeVisible();
  });

  test('no surface scrolls sideways on a phone', async ({ page }) => {
    await page.setViewportSize({ width: 393, height: 852 });
    for (const path of [BOARD, `${BOARD}?section=ticker`, `${BOARD}?section=messages`]) {
      await open(page, path);
      if (await refused(page)) continue;
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth
      );
      expect(overflow, `${path} scrolls sideways by ${overflow}px`).toBeLessThanOrEqual(1);
    }
  });
});
