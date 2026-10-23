import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { handReviewAwardsFixture } from '../helpers/hand-review-awards-fixture.mjs';

for (const viewport of [
  { width: 375, height: 812 },
  { width: 1280, height: 720 },
]) {
  test(`recorded fold awards remain inside Summary and Detail at ${viewport.width}px`, async ({
    page,
  }) => {
    const fixture = process.env.HAND_REVIEW_PREIMAGE
      ? JSON.parse(readFileSync(process.env.HAND_REVIEW_PREIMAGE, 'utf8'))
      : await handReviewAwardsFixture();
    await page.setViewportSize(viewport);
    await page.route('http://hand-review.fixture/**', async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/')
        return route.fulfill({
          contentType: 'text/html',
          body: '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div></body></html>',
        });
      try {
        return await route.fulfill({ path: resolve('public', pathname.slice(1)) });
      } catch {
        return route.fulfill({ status: 404, body: '' });
      }
    });
    await page.goto('http://hand-review.fixture/');
    await page.addStyleTag({
      content: `html,body{margin:0;background:#000}*,*::before,*::after{box-sizing:border-box}${fixture.css}`,
    });
    await page.addScriptTag({ content: fixture.javascript });
    await expect(page.getByRole('region', { name: 'Pot Awards', exact: true })).toBeAttached();
    await page.evaluate(() => document.fonts.ready);
    for (const tab of ['Hand Summary', 'Hand Detail']) {
      await page.getByRole('tab', { name: tab, exact: true }).click();
      const section = page.getByRole('region', { name: 'Pot Awards', exact: true });
      await expect(
        page.getByRole('img', { name: 'Queen Of Hearts', exact: true }).first()
      ).toBeAttached();
      await expect(
        page.getByRole('img', { name: 'Six Of Hearts', exact: true }).first()
      ).toBeAttached();
      await expect(section).toContainText('Collected 46.62');
      await expect(section).toContainText('Collected 46.63');
      await expect(section).toContainText('Main 46.62');
      await expect(section).toContainText('Main 46.63');
      const cards = page.getByRole('region', { name: 'Your Cards', exact: true }).getByRole('img');
      await expect(cards).toHaveCount(2);
      for (const card of await cards.all()) {
        await expect
          .poll(() =>
            card.evaluate(
              (node) => node instanceof HTMLImageElement && node.complete && node.naturalWidth > 0
            )
          )
          .toBe(true);
      }
      const geometry = await section.evaluate((node) => {
        const frame = node.getBoundingClientRect();
        const rows = [...node.children].slice(1).map((row) => {
          const rect = row.getBoundingClientRect();
          return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right };
        });
        return {
          top: frame.top,
          bottom: frame.bottom,
          left: frame.left,
          right: frame.right,
          height: frame.height,
          rows,
        };
      });
      expect(geometry.height, `${tab} award section clips its rows`).toBeGreaterThan(100);
      expect(geometry.rows).toHaveLength(2);
      for (const row of geometry.rows) {
        expect(row.top).toBeGreaterThanOrEqual(geometry.top - 1);
        expect(row.bottom).toBeLessThanOrEqual(geometry.bottom + 1);
        expect(row.left).toBeGreaterThanOrEqual(geometry.left - 1);
        expect(row.right).toBeLessThanOrEqual(geometry.right + 1);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        viewport.width
      );
    }
  });
}
